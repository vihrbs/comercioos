const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { verificarPermissao } = require('../middleware/permissao');

// authMiddleware e verificarPlano já são aplicados em server.js.
// Aqui dentro, cada rota escolhe qual módulo de permissão exigir, porque
// esse arquivo atende duas telas diferentes do front (PDV e Vendas/Histórico).

/*
 * IMPORTANTE — baixa de estoque atômica:
 * Ler o estoque e depois escrever em duas chamadas separadas permite que
 * duas vendas simultâneas leiam o mesmo valor antes de uma delas escrever,
 * causando venda de itens que não existem mais (condição de corrida).
 *
 * Este arquivo assume uma função SQL no Supabase que faz o decremento de
 * forma atômica e só aplica se houver estoque suficiente. Rode isso uma vez
 * no SQL Editor do Supabase antes de usar o código abaixo:
 *
 *   create or replace function baixar_estoque(p_variacao_id uuid, p_quantidade int)
 *   returns table(estoque_restante int) as $$
 *     update variacoes
 *     set estoque = estoque - p_quantidade
 *     where id = p_variacao_id and estoque >= p_quantidade
 *     returning estoque;
 *   $$ language sql volatile;
 *
 * Se a função não existir ainda, o código usa um fallback (leitura + escrita
 * condicional) que reduz — mas não elimina — a janela de corrida.
 */
async function baixarEstoqueAtomico(variacao_id, quantidade) {
  const { data, error } = await supabase.rpc('baixar_estoque', {
    p_variacao_id: variacao_id,
    p_quantidade: quantidade
  });

  if (!error) {
    return { ok: data && data.length > 0, estoqueInsuficiente: !(data && data.length > 0) };
  }

  // Fallback se a função RPC ainda não foi criada no banco (não é 100% atômico,
  // mas evita estoque negativo e é melhor que o comportamento anterior)
  const { data: variacaoAtual } = await supabase.from('variacoes')
    .select('estoque').eq('id', variacao_id).single();
  if (!variacaoAtual) return { ok: false, estoqueInsuficiente: false };
  if (variacaoAtual.estoque < quantidade) return { ok: false, estoqueInsuficiente: true };

  const { data: upd } = await supabase.from('variacoes')
    .update({ estoque: variacaoAtual.estoque - quantidade })
    .eq('id', variacao_id).eq('estoque', variacaoAtual.estoque) // reduz a janela de corrida
    .select().maybeSingle();

  return { ok: !!upd, estoqueInsuficiente: !upd };
}

async function gerarNumeroVenda(loja_id) {
  const { count } = await supabase.from('vendas')
    .select('*', { count: 'exact', head: true }).eq('loja_id', loja_id);
  return `V-${String((count || 0) + 1).padStart(5, '0')}`;
}

router.get('/', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  try {
    const { data_inicio, data_fim, status, funcionario_id, page = 1 } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    let query = supabase.from('vendas')
      .select('*, clientes(nome, telefone), funcionarios(nome)', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .order('criado_em', { ascending: false });

    if (status) query = query.eq('status', status);
    if (funcionario_id) query = query.eq('funcionario_id', funcionario_id);
    if (data_inicio) query = query.gte('criado_em', data_inicio);
    if (data_fim) query = query.lte('criado_em', data_fim + 'T23:59:59');

    const paginaAtual = Math.max(1, Number(page) || 1);
    const from = (paginaAtual - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  const { data, error } = await supabase.from('vendas')
    .select('*, clientes(*), funcionarios(nome), venda_itens(*)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Venda não encontrada' });
  res.json(data);
});

router.post('/', verificarPermissao('pdv'), async (req, res) => {
  try {
    const { itens, cliente_id, funcionario_id, forma_pagamento, parcelas,
            desconto_pct, desconto_valor, acrescimo, observacoes, troco } = req.body;

    if (!itens || itens.length === 0) {
      return res.status(400).json({ error: 'Venda sem itens' });
    }

    // Crediário exige cliente
    if (forma_pagamento === 'crediario' && !cliente_id) {
      return res.status(400).json({ error: 'Crediário exige um cliente selecionado' });
    }

    // ---- PREÇO NUNCA VEM DO CLIENTE: busca o preço real de cada item no banco ----
    // (evita que alguém chamando a API direto envie um preco_unitario falso)
    const idsVariacoes = itens.filter(i => i.variacao_id).map(i => i.variacao_id);
    const { data: variacoesReais } = idsVariacoes.length
      ? await supabase.from('variacoes')
          .select('id, estoque, produtos!inner(id, preco_venda, loja_id)')
          .in('id', idsVariacoes)
      : { data: [] };

    const mapaVariacoes = {};
    (variacoesReais || []).forEach(v => { mapaVariacoes[v.id] = v; });

    let subtotal = 0;
    const itensProcessados = [];
    for (const item of itens) {
      let precoReal;
      if (item.variacao_id) {
        const v = mapaVariacoes[item.variacao_id];
        // Garante que a variação pertence a um produto desta loja (evita
        // vender item de outra loja usando um variacao_id adivinhado)
        if (!v || v.produtos.loja_id !== req.user.loja_id) {
          return res.status(400).json({ error: `Item inválido: ${item.nome_produto || item.variacao_id}` });
        }
        precoReal = v.produtos.preco_venda;
      } else {
        // Item sem variação cadastrada (ex: serviço avulso) — não temos como
        // validar preço contra o banco; mantém o valor mas fica registrado.
        precoReal = item.preco_unitario;
      }
      const sub = precoReal * item.quantidade - (item.desconto || 0);
      subtotal += sub;
      itensProcessados.push({ ...item, preco_unitario: precoReal, subtotal: sub });
    }

    const desc_val = desconto_valor || (subtotal * (desconto_pct || 0) / 100);
    const total = subtotal - desc_val + (acrescimo || 0);

    // Crediário: status_pagamento = 'pendente'
    const statusPagamento = forma_pagamento === 'crediario' ? 'pendente' : 'pago';

    const numero = await gerarNumeroVenda(req.user.loja_id);

    const { data: venda, error: vendaErr } = await supabase.from('vendas').insert({
      loja_id: req.user.loja_id,
      cliente_id: cliente_id || null,
      funcionario_id: funcionario_id || null,
      numero, subtotal, desconto_pct: desconto_pct || 0,
      desconto_valor: desc_val, acrescimo: acrescimo || 0,
      total, forma_pagamento, parcelas: parcelas || 1,
      status: 'finalizada', status_pagamento: statusPagamento,
      troco: troco || 0, observacoes
    }).select().single();
    if (vendaErr) throw vendaErr;

    // Insere itens (já com preco_unitario/subtotal reais)
    await supabase.from('venda_itens').insert(
      itensProcessados.map(i => ({ ...i, venda_id: venda.id }))
    );

    // Baixa estoque de forma atômica — se algum item não tiver estoque
    // suficiente, a venda já foi criada (mantemos assim para não complicar
    // o fluxo de PDV), mas avisamos no retorno.
    const itensSemEstoque = [];
    for (const item of itens) {
      if (item.variacao_id) {
        const { ok, estoqueInsuficiente } = await baixarEstoqueAtomico(item.variacao_id, item.quantidade);
        if (!ok && estoqueInsuficiente) itensSemEstoque.push(item.nome_produto || item.variacao_id);
      }
    }

    // Atualiza cliente
    if (cliente_id) {
      const { data: cliente } = await supabase.from('clientes')
        .select('total_compras, num_compras, pontos')
        .eq('id', cliente_id).eq('loja_id', req.user.loja_id).single();
      if (cliente) {
        await supabase.from('clientes').update({
          total_compras: (cliente.total_compras || 0) + total,
          num_compras: (cliente.num_compras || 0) + 1,
          ultima_compra: new Date(),
          pontos: (cliente.pontos || 0) + Math.floor(total)
        }).eq('id', cliente_id).eq('loja_id', req.user.loja_id);
      }
    }

    // Movimentação financeira (só para pagamentos à vista)
    if (forma_pagamento !== 'crediario') {
      await supabase.from('movimentacoes').insert({
        loja_id: req.user.loja_id,
        tipo: 'entrada',
        categoria: 'venda',
        descricao: `Venda ${numero}`,
        valor: total,
        forma_pagamento,
        referencia_id: venda.id
      });
    }

    // Cria registro de crediário
    if (forma_pagamento === 'crediario' && cliente_id) {
      const vencimento = new Date();
      vencimento.setDate(vencimento.getDate() + 30);

      await supabase.from('crediario').insert({
        loja_id: req.user.loja_id,
        cliente_id,
        venda_id: venda.id,
        total,
        pago: 0,
        saldo: total,
        parcelas: parcelas || 1,
        parcelas_pagas: 0,
        status: 'ativo',
        vencimento: vencimento.toISOString()
      });
    }

    res.status(201).json({ ...venda, avisos: itensSemEstoque.length ? { estoque_insuficiente: itensSemEstoque } : undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/cancelar', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  try {
    // SEMPRE filtra por loja_id — sem isso, qualquer usuário logado
    // conseguiria cancelar a venda de qualquer outra loja do sistema.
    const { data: venda } = await supabase.from('vendas')
      .select('*, venda_itens(*)')
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
    if (!venda) return res.status(404).json({ error: 'Venda não encontrada' });
    if (venda.status === 'cancelada') return res.status(400).json({ error: 'Venda já está cancelada' });

    await supabase.from('vendas').update({ status: 'cancelada' })
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id);

    for (const item of venda.venda_itens || []) {
      if (item.variacao_id) {
        const { data: v } = await supabase.from('variacoes').select('estoque').eq('id', item.variacao_id).single();
        if (v) await supabase.from('variacoes').update({ estoque: v.estoque + item.quantidade }).eq('id', item.variacao_id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
