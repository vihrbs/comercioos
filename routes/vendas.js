const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

async function gerarNumeroVenda(loja_id) {
  const { count } = await supabase.from('vendas')
    .select('*', { count: 'exact', head: true }).eq('loja_id', loja_id);
  return `V-${String((count || 0) + 1).padStart(5, '0')}`;
}

router.get('/', async (req, res) => {
  try {
    const { data_inicio, data_fim, status, funcionario_id, page = 1, limit = 50 } = req.query;
    let query = supabase.from('vendas')
      .select('*, clientes(nome, telefone), funcionarios(nome)', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .order('criado_em', { ascending: false });

    if (status) query = query.eq('status', status);
    if (funcionario_id) query = query.eq('funcionario_id', funcionario_id);
    if (data_inicio) query = query.gte('criado_em', data_inicio);
    if (data_fim) query = query.lte('criado_em', data_fim + 'T23:59:59');

    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('vendas')
    .select('*, clientes(*), funcionarios(nome), venda_itens(*)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Venda não encontrada' });
  res.json(data);
});

router.post('/', async (req, res) => {
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

    const numero = await gerarNumeroVenda(req.user.loja_id);

    let subtotal = 0;
    const itensProcessados = itens.map(item => {
      const sub = item.preco_unitario * item.quantidade - (item.desconto || 0);
      subtotal += sub;
      return { ...item, subtotal: sub };
    });

    const desc_val = desconto_valor || (subtotal * (desconto_pct || 0) / 100);
    const total = subtotal - desc_val + (acrescimo || 0);

    // Crediário: status_pagamento = 'pendente'
    const statusPagamento = forma_pagamento === 'crediario' ? 'pendente' : 'pago';

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

    // Insere itens
    await supabase.from('venda_itens').insert(
      itensProcessados.map(i => ({ ...i, venda_id: venda.id }))
    );

    // Baixa estoque
    for (const item of itens) {
      if (item.variacao_id) {
        const { data: variacaoAtual } = await supabase.from('variacoes')
          .select('estoque').eq('id', item.variacao_id).single();
        if (variacaoAtual) {
          await supabase.from('variacoes')
            .update({ estoque: Math.max(0, variacaoAtual.estoque - item.quantidade) })
            .eq('id', item.variacao_id);
        }
      }
    }

    // Atualiza cliente
    if (cliente_id) {
      const { data: cliente } = await supabase.from('clientes')
        .select('total_compras, num_compras, pontos').eq('id', cliente_id).single();
      if (cliente) {
        await supabase.from('clientes').update({
          total_compras: (cliente.total_compras || 0) + total,
          num_compras: (cliente.num_compras || 0) + 1,
          ultima_compra: new Date(),
          pontos: (cliente.pontos || 0) + Math.floor(total)
        }).eq('id', cliente_id);
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
        parcelas: parcelas || 1,        // campo correto: parcelas (não num_parcelas)
        parcelas_pagas: 0,
        status: 'ativo',
        vencimento: vencimento.toISOString()
      });
    }

    res.status(201).json(venda);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/cancelar', async (req, res) => {
  try {
    const { data: venda } = await supabase.from('vendas')
      .select('*, venda_itens(*)').eq('id', req.params.id).single();
    if (!venda) return res.status(404).json({ error: 'Venda não encontrada' });

    await supabase.from('vendas').update({ status: 'cancelada' }).eq('id', req.params.id);

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
