const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { verificarPermissao } = require('../middleware/permissao');

// authMiddleware e verificarPlano já são aplicados em server.js.
// Trocas atende a mesma tela do PDV/Vendas, então usa o mesmo módulo delas.

async function devolverEstoqueAtomico(variacao_id, quantidade) {
  const { data, error } = await supabase.rpc('devolver_estoque', {
    p_variacao_id: variacao_id,
    p_quantidade: quantidade
  });
  if (!error && data && data.length > 0) return true;

  // Fallback se a função RPC ainda não existir no banco
  const { data: v } = await supabase.from('variacoes').select('estoque').eq('id', variacao_id).single();
  if (!v) return false;
  await supabase.from('variacoes').update({ estoque: v.estoque + quantidade }).eq('id', variacao_id);
  return true;
}

async function baixarEstoqueAtomico(variacao_id, quantidade) {
  const { data, error } = await supabase.rpc('baixar_estoque', {
    p_variacao_id: variacao_id,
    p_quantidade: quantidade
  });
  if (!error) return { ok: data && data.length > 0 };

  const { data: v } = await supabase.from('variacoes').select('estoque').eq('id', variacao_id).single();
  if (!v || v.estoque < quantidade) return { ok: false };
  await supabase.from('variacoes').update({ estoque: v.estoque - quantidade }).eq('id', variacao_id);
  return { ok: true };
}

// Soma quantas unidades de uma variação, dentro de uma venda, já foram
// devolvidas em trocas anteriores — evita devolver mais do que foi comprado.
async function quantidadeJaDevolvida(venda_id, variacao_id) {
  const { data: trocasAnteriores } = await supabase.from('trocas')
    .select('itens_devolvidos').eq('venda_original_id', venda_id);
  let total = 0;
  (trocasAnteriores || []).forEach(t => {
    (t.itens_devolvidos || []).forEach(i => {
      if (i.variacao_id === variacao_id) total += i.quantidade;
    });
  });
  return total;
}

// Busca o preço real e a quantidade comprada de um item numa venda, direto
// do banco — nunca confia em preço/quantidade que o cliente possa enviar.
async function buscarItemVendaOriginal(venda_id, variacao_id) {
  const { data } = await supabase.from('venda_itens')
    .select('quantidade, preco_unitario, nome_produto')
    .eq('venda_id', venda_id).eq('variacao_id', variacao_id).maybeSingle();
  return data;
}

router.get('/', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const paginaAtual = Math.max(1, Number(page) || 1);

    const { data, error, count } = await supabase.from('trocas')
      .select('*, clientes(nome), vendas!trocas_venda_original_id_fkey(numero)', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .order('criado_em', { ascending: false })
      .range((paginaAtual - 1) * limit, paginaAtual * limit - 1);

    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  const { data, error } = await supabase.from('trocas')
    .select('*, clientes(nome, telefone), vendas!trocas_venda_original_id_fkey(numero)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Troca não encontrada' });
  res.json(data);
});

/**
 * POST /api/trocas
 * body: {
 *   venda_original_id,
 *   itens_devolvidos: [{ variacao_id, quantidade }],
 *   tipo: 'credito' | 'reembolso' | 'troca_direta',
 *   itens_novos: [{ variacao_id, quantidade }]   // só se tipo = troca_direta
 *   forma_pagamento_diferenca: 'pix' | 'dinheiro' | ...  // se cliente precisa pagar diferença
 *   destino_sobra: 'credito' | 'reembolso'       // se sobrar valor na troca_direta
 * }
 */
router.post('/', verificarPermissao('pdv'), async (req, res) => {
  try {
    const {
      venda_original_id, itens_devolvidos, tipo,
      itens_novos, forma_pagamento_diferenca, destino_sobra, observacoes
    } = req.body;

    if (!venda_original_id || !itens_devolvidos || itens_devolvidos.length === 0) {
      return res.status(400).json({ error: 'Informe a venda original e os itens devolvidos' });
    }
    if (!['credito', 'reembolso', 'troca_direta'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de troca inválido' });
    }

    // Venda original precisa ser da mesma loja
    const { data: vendaOriginal } = await supabase.from('vendas')
      .select('id, cliente_id, status').eq('id', venda_original_id).eq('loja_id', req.user.loja_id).single();
    if (!vendaOriginal) return res.status(404).json({ error: 'Venda original não encontrada' });
    if (vendaOriginal.status === 'cancelada') return res.status(400).json({ error: 'Venda original está cancelada' });

    const cliente_id = vendaOriginal.cliente_id;
    if (tipo === 'credito' && !cliente_id) {
      return res.status(400).json({ error: 'Troca por crédito exige cliente identificado na venda original' });
    }

    // ---- Valida e calcula o valor devolvido a partir dos dados REAIS da venda ----
    let valorDevolvido = 0;
    const itensDevolvidosProcessados = [];
    for (const item of itens_devolvidos) {
      const itemOriginal = await buscarItemVendaOriginal(venda_original_id, item.variacao_id);
      if (!itemOriginal) {
        return res.status(400).json({ error: `Item ${item.variacao_id} não pertence a essa venda` });
      }
      const jaDevolvida = await quantidadeJaDevolvida(venda_original_id, item.variacao_id);
      const disponivelPraDevolver = itemOriginal.quantidade - jaDevolvida;
      if (item.quantidade <= 0 || item.quantidade > disponivelPraDevolver) {
        return res.status(400).json({
          error: `Quantidade inválida para "${itemOriginal.nome_produto}" — disponível para devolução: ${disponivelPraDevolver}`
        });
      }
      const valorItem = itemOriginal.preco_unitario * item.quantidade;
      valorDevolvido += valorItem;
      itensDevolvidosProcessados.push({
        variacao_id: item.variacao_id,
        quantidade: item.quantidade,
        valor_unitario: itemOriginal.preco_unitario,
        nome_produto: itemOriginal.nome_produto
      });
    }

    // Devolve estoque dos itens trocados/devolvidos
    for (const item of itensDevolvidosProcessados) {
      await devolverEstoqueAtomico(item.variacao_id, item.quantidade);
    }

    let valorNovosItens = 0;
    const itensNovosProcessados = [];

    // ---- Troca direta: valida preço real dos itens novos, igual ao PDV ----
    if (tipo === 'troca_direta') {
      if (!itens_novos || itens_novos.length === 0) {
        return res.status(400).json({ error: 'Troca direta exige os itens novos' });
      }
      for (const item of itens_novos) {
        const { data: variacao } = await supabase.from('variacoes')
          .select('id, estoque, produtos!inner(preco_venda, loja_id, nome)')
          .eq('id', item.variacao_id).single();
        if (!variacao || variacao.produtos.loja_id !== req.user.loja_id) {
          return res.status(400).json({ error: `Item novo inválido: ${item.variacao_id}` });
        }
        const { ok } = await baixarEstoqueAtomico(item.variacao_id, item.quantidade);
        if (!ok) return res.status(400).json({ error: `Estoque insuficiente para ${variacao.produtos.nome}` });

        const valorItem = variacao.produtos.preco_venda * item.quantidade;
        valorNovosItens += valorItem;
        itensNovosProcessados.push({
          variacao_id: item.variacao_id,
          quantidade: item.quantidade,
          preco_unitario: variacao.produtos.preco_venda,
          nome_produto: variacao.produtos.nome
        });
      }
    }

    const valorDiferenca = valorNovosItens - valorDevolvido;

    // ---- Aplica o resultado financeiro da troca ----
    if (tipo === 'credito' || (tipo === 'troca_direta' && valorDiferenca < 0 && destino_sobra !== 'reembolso')) {
      // Vira saldo de crédito pro cliente
      const valorCredito = tipo === 'credito' ? valorDevolvido : Math.abs(valorDiferenca);
      const { data: cliente } = await supabase.from('clientes')
        .select('saldo_credito').eq('id', cliente_id).eq('loja_id', req.user.loja_id).single();
      const novoSaldo = (cliente?.saldo_credito || 0) + valorCredito;

      await supabase.from('clientes').update({ saldo_credito: novoSaldo })
        .eq('id', cliente_id).eq('loja_id', req.user.loja_id);
      await supabase.from('credito_historico').insert({
        loja_id: req.user.loja_id, cliente_id, tipo: 'credito',
        valor: valorCredito, origem: 'troca', saldo_apos: novoSaldo
      });
    } else if (tipo === 'reembolso' || (tipo === 'troca_direta' && valorDiferenca < 0 && destino_sobra === 'reembolso')) {
      // Dinheiro sai do caixa
      const valorReembolso = tipo === 'reembolso' ? valorDevolvido : Math.abs(valorDiferenca);
      await supabase.from('movimentacoes').insert({
        loja_id: req.user.loja_id, tipo: 'saida', categoria: 'devolucao',
        descricao: `Reembolso troca — venda original`, valor: valorReembolso,
        forma_pagamento: forma_pagamento_diferenca || 'dinheiro'
      });
    }

    if (tipo === 'troca_direta' && valorDiferenca > 0) {
      // Cliente precisa pagar a diferença
      if (!forma_pagamento_diferenca) {
        return res.status(400).json({ error: 'Informe a forma de pagamento da diferença' });
      }
      await supabase.from('movimentacoes').insert({
        loja_id: req.user.loja_id, tipo: 'entrada', categoria: 'troca',
        descricao: `Diferença de troca`, valor: valorDiferenca,
        forma_pagamento: forma_pagamento_diferenca
      });
    }

    const { data: troca, error: trocaErr } = await supabase.from('trocas').insert({
      loja_id: req.user.loja_id,
      venda_original_id,
      cliente_id,
      funcionario_id: req.body.funcionario_id || null,
      tipo,
      itens_devolvidos: itensDevolvidosProcessados,
      itens_novos: itensNovosProcessados.length ? itensNovosProcessados : null,
      valor_devolvido: valorDevolvido,
      valor_novos_itens: valorNovosItens,
      valor_diferenca: valorDiferenca,
      observacoes: observacoes || null
    }).select().single();
    if (trocaErr) throw trocaErr;

    res.status(201).json(troca);
  } catch (err) {
    console.error('Erro ao processar troca:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
