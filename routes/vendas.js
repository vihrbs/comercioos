const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { verificarPermissao } = require('../middleware/permissao');

// authMiddleware e verificarPlano já são aplicados em server.js.
// Aqui dentro, cada rota escolhe qual módulo de permissão exigir, porque
// esse arquivo atende duas telas diferentes do front (PDV e Vendas/Histórico).

/*
 * IMPORTANTE — baixa de estoque atômica: veja migration_baixar_estoque.sql
 * e migration_features_v2.sql (função devolver_estoque, usada pelas trocas).
 */
async function baixarEstoqueAtomico(variacao_id, quantidade) {
  const { data, error } = await supabase.rpc('baixar_estoque', {
    p_variacao_id: variacao_id,
    p_quantidade: quantidade
  });

  if (!error) {
    return { ok: data && data.length > 0, estoqueInsuficiente: !(data && data.length > 0) };
  }

  const { data: variacaoAtual } = await supabase.from('variacoes')
    .select('estoque').eq('id', variacao_id).single();
  if (!variacaoAtual) return { ok: false, estoqueInsuficiente: false };
  if (variacaoAtual.estoque < quantidade) return { ok: false, estoqueInsuficiente: true };

  const { data: upd } = await supabase.from('variacoes')
    .update({ estoque: variacaoAtual.estoque - quantidade })
    .eq('id', variacao_id).eq('estoque', variacaoAtual.estoque)
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
    .select('*, clientes(*), funcionarios(nome), venda_itens(*), venda_pagamentos(*)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Venda não encontrada' });
  res.json(data);
});

/**
 * POST /api/vendas
 * `forma_pagamento` continua aceito (compatibilidade — pagamento único).
 * Para pagamento dividido, envie `pagamentos: [{ forma_pagamento, valor }]`
 * em vez de `forma_pagamento` — a soma precisa bater com o total da venda.
 * 'credito_loja' é uma forma de pagamento válida: debita do saldo_credito
 * do cliente (exige cliente_id e saldo suficiente).
 */
router.post('/', verificarPermissao('pdv'), async (req, res) => {
  try {
    const { itens, cliente_id, funcionario_id, forma_pagamento, pagamentos, parcelas,
            desconto_pct, desconto_valor, acrescimo, observacoes, troco } = req.body;

    if (!itens || itens.length === 0) {
      return res.status(400).json({ error: 'Venda sem itens' });
    }

    const usaPagamentoDividido = Array.isArray(pagamentos) && pagamentos.length > 0;
    if (!usaPagamentoDividido && !forma_pagamento) {
      return res.status(400).json({ error: 'Informe a forma de pagamento' });
    }

    const formasUsadas = usaPagamentoDividido ? pagamentos.map(p => p.forma_pagamento) : [forma_pagamento];

    // Crediário exige cliente
    if (formasUsadas.includes('crediario') && !cliente_id) {
      return res.status(400).json({ error: 'Crediário exige um cliente selecionado' });
    }
    // Crédito de loja exige cliente (o saldo é dele)
    if (formasUsadas.includes('credito_loja') && !cliente_id) {
      return res.status(400).json({ error: 'Pagamento com crédito de loja exige um cliente selecionado' });
    }

    // ---- PREÇO NUNCA VEM DO CLIENTE: busca o preço real de cada item no banco ----
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
        if (!v || v.produtos.loja_id !== req.user.loja_id) {
          return res.status(400).json({ error: `Item inválido: ${item.nome_produto || item.variacao_id}` });
        }
        precoReal = v.produtos.preco_venda;
      } else {
        precoReal = item.preco_unitario;
      }
      const sub = precoReal * item.quantidade - (item.desconto || 0);
      subtotal += sub;
      itensProcessados.push({ ...item, preco_unitario: precoReal, subtotal: sub });
    }

    const desc_val = desconto_valor || (subtotal * (desconto_pct || 0) / 100);
    const total = subtotal - desc_val + (acrescimo || 0);

    // ---- Valida pagamento dividido: a soma precisa bater com o total ----
    if (usaPagamentoDividido) {
      const somaPagamentos = pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0);
      if (Math.abs(somaPagamentos - total) > 0.01) {
        return res.status(400).json({
          error: `Soma dos pagamentos (R$${somaPagamentos.toFixed(2)}) não corresponde ao total da venda (R$${total.toFixed(2)})`
        });
      }
    }

    // ---- Valida saldo de crédito de loja, se usado ----
    const valorCreditoLoja = usaPagamentoDividido
      ? pagamentos.filter(p => p.forma_pagamento === 'credito_loja').reduce((s, p) => s + Number(p.valor || 0), 0)
      : (forma_pagamento === 'credito_loja' ? total : 0);

    let clienteAtual = null;
    if (cliente_id) {
      const { data: c } = await supabase.from('clientes')
        .select('total_compras, num_compras, pontos, saldo_credito')
        .eq('id', cliente_id).eq('loja_id', req.user.loja_id).single();
      clienteAtual = c;
    }
    if (valorCreditoLoja > 0) {
      if (!clienteAtual) return res.status(400).json({ error: 'Cliente não encontrado' });
      if ((clienteAtual.saldo_credito || 0) < valorCreditoLoja) {
        return res.status(400).json({ error: 'Saldo de crédito insuficiente' });
      }
    }

    const temCrediario = formasUsadas.includes('crediario');
    const statusPagamento = temCrediario ? 'pendente' : 'pago';
    const formaPrincipal = usaPagamentoDividido
      ? (pagamentos.length > 1 ? 'misto' : pagamentos[0].forma_pagamento)
      : forma_pagamento;

    const numero = await gerarNumeroVenda(req.user.loja_id);

    const { data: venda, error: vendaErr } = await supabase.from('vendas').insert({
      loja_id: req.user.loja_id,
      cliente_id: cliente_id || null,
      funcionario_id: funcionario_id || null,
      numero, subtotal, desconto_pct: desconto_pct || 0,
      desconto_valor: desc_val, acrescimo: acrescimo || 0,
      total, forma_pagamento: formaPrincipal, parcelas: parcelas || 1,
      status: 'finalizada', status_pagamento: statusPagamento,
      troco: troco || 0, observacoes
    }).select().single();
    if (vendaErr) throw vendaErr;

    const linhasPagamento = usaPagamentoDividido
      ? pagamentos.map(p => ({ venda_id: venda.id, forma_pagamento: p.forma_pagamento, valor: Number(p.valor) }))
      : [{ venda_id: venda.id, forma_pagamento, valor: total }];
    await supabase.from('venda_pagamentos').insert(linhasPagamento);

    await supabase.from('venda_itens').insert(
      itensProcessados.map(i => ({ ...i, venda_id: venda.id }))
    );

    const itensSemEstoque = [];
    for (const item of itens) {
      if (item.variacao_id) {
        const { ok, estoqueInsuficiente } = await baixarEstoqueAtomico(item.variacao_id, item.quantidade);
        if (!ok && estoqueInsuficiente) itensSemEstoque.push(item.nome_produto || item.variacao_id);
      }
    }

    if (valorCreditoLoja > 0 && clienteAtual) {
      const novoSaldoCredito = (clienteAtual.saldo_credito || 0) - valorCreditoLoja;
      await supabase.from('clientes').update({ saldo_credito: novoSaldoCredito })
        .eq('id', cliente_id).eq('loja_id', req.user.loja_id);
      await supabase.from('credito_historico').insert({
        loja_id: req.user.loja_id, cliente_id, tipo: 'debito',
        valor: valorCreditoLoja, origem: 'venda', referencia_id: venda.id,
        saldo_apos: novoSaldoCredito
      });
    }

    if (cliente_id && clienteAtual) {
      await supabase.from('clientes').update({
        total_compras: (clienteAtual.total_compras || 0) + total,
        num_compras: (clienteAtual.num_compras || 0) + 1,
        ultima_compra: new Date(),
        pontos: (clienteAtual.pontos || 0) + Math.floor(total)
      }).eq('id', cliente_id).eq('loja_id', req.user.loja_id);
    }

    for (const p of linhasPagamento) {
      if (p.forma_pagamento !== 'crediario' && p.forma_pagamento !== 'credito_loja') {
        await supabase.from('movimentacoes').insert({
          loja_id: req.user.loja_id, tipo: 'entrada', categoria: 'venda',
          descricao: `Venda ${numero}`, valor: p.valor,
          forma_pagamento: p.forma_pagamento, referencia_id: venda.id
        });
      }
    }

    if (temCrediario && cliente_id) {
      const valorCrediario = usaPagamentoDividido
        ? pagamentos.filter(p => p.forma_pagamento === 'crediario').reduce((s, p) => s + Number(p.valor || 0), 0)
        : total;

      const vencimento = new Date();
      vencimento.setDate(vencimento.getDate() + 30);

      await supabase.from('crediario').insert({
        loja_id: req.user.loja_id,
        cliente_id,
        venda_id: venda.id,
        total: valorCrediario,
        pago: 0,
        saldo: valorCrediario,
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

/**
 * PUT /api/vendas/:id/corrigir-pagamento
 * Corrige a forma de pagamento de uma venda já finalizada, sem cancelar
 * tudo. Só troca o rótulo — não recalcula estoque nem valores. Toda
 * correção fica registrada em vendas_correcoes pra auditoria.
 */
router.put('/:id/corrigir-pagamento', verificarPermissao(['pdv', 'vendas']), async (req, res) => {
  try {
    const { forma_pagamento_nova, motivo } = req.body;
    if (!forma_pagamento_nova) return res.status(400).json({ error: 'Informe a nova forma de pagamento' });

    const { data: venda } = await supabase.from('vendas')
      .select('id, forma_pagamento, status')
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
    if (!venda) return res.status(404).json({ error: 'Venda não encontrada' });
    if (venda.status === 'cancelada') return res.status(400).json({ error: 'Venda cancelada não pode ser corrigida' });

    await supabase.from('vendas').update({ forma_pagamento: forma_pagamento_nova })
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id);

    await supabase.from('vendas_correcoes').insert({
      venda_id: req.params.id,
      usuario_id: req.user.id,
      forma_pagamento_antiga: venda.forma_pagamento,
      forma_pagamento_nova,
      motivo: motivo || null
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
