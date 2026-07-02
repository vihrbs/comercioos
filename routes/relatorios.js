const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/dashboard', async (req, res) => {
  try {
    const loja_id = req.user.loja_id;
    const hoje = new Date().toISOString().split('T')[0];
    const inicioMes = hoje.substring(0, 8) + '01';

    const { data: vendasHoje } = await supabase.from('vendas')
      .select('total').eq('loja_id', loja_id).eq('status', 'finalizada')
      .gte('criado_em', hoje).lte('criado_em', hoje + 'T23:59:59');

    const { data: vendasMes } = await supabase.from('vendas')
      .select('total, forma_pagamento').eq('loja_id', loja_id).eq('status', 'finalizada')
      .gte('criado_em', inicioMes);

    const { count: totalClientes } = await supabase.from('clientes')
      .select('*', { count: 'exact', head: true }).eq('loja_id', loja_id).eq('ativo', true);

    const { count: totalProdutos } = await supabase.from('produtos')
      .select('*', { count: 'exact', head: true }).eq('loja_id', loja_id).eq('ativo', true);

    const { data: ultimasVendas } = await supabase.from('vendas')
      .select('numero, total, forma_pagamento, criado_em, clientes(nome)')
      .eq('loja_id', loja_id).eq('status', 'finalizada')
      .order('criado_em', { ascending: false }).limit(5);

    const { data: itensMes } = await supabase.from('venda_itens')
      .select('nome_produto, quantidade, subtotal, vendas!inner(loja_id, status)')
      .eq('vendas.loja_id', loja_id).eq('vendas.status', 'finalizada');

    const produtosAgrup = {};
    (itensMes || []).forEach(i => {
      if (!produtosAgrup[i.nome_produto]) {
        produtosAgrup[i.nome_produto] = { nome: i.nome_produto, qtd: 0, total: 0 };
      }
      produtosAgrup[i.nome_produto].qtd += i.quantidade;
      produtosAgrup[i.nome_produto].total += i.subtotal;
    });
    const topProdutos = Object.values(produtosAgrup).sort((a, b) => b.qtd - a.qtd).slice(0, 5);

    const pagamentos = {};
    (vendasMes || []).forEach(v => {
      pagamentos[v.forma_pagamento] = (pagamentos[v.forma_pagamento] || 0) + v.total;
    });

    const totalHoje = (vendasHoje || []).reduce((s, v) => s + v.total, 0);
    const totalMes = (vendasMes || []).reduce((s, v) => s + v.total, 0);
    const numVendasHoje = vendasHoje?.length || 0;

    res.json({
      hoje: { total: totalHoje, num_vendas: numVendasHoje, ticket_medio: numVendasHoje ? totalHoje / numVendasHoje : 0 },
      mes: { total: totalMes, num_vendas: vendasMes?.length || 0, por_pagamento: pagamentos },
      totais: { clientes: totalClientes || 0, produtos: totalProdutos || 0 },
      ultimas_vendas: ultimasVendas || [],
      top_produtos: topProdutos,
      estoque_critico: []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vendas-periodo', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const { data: vendas } = await supabase.from('vendas')
      .select('numero, total, criado_em, forma_pagamento, clientes(nome)')
      .eq('loja_id', req.user.loja_id).eq('status', 'finalizada')
      .gte('criado_em', data_inicio || new Date(Date.now() - 30 * 86400000).toISOString())
      .lte('criado_em', (data_fim || new Date().toISOString().split('T')[0]) + 'T23:59:59')
      .order('criado_em', { ascending: false });

    const porDia = {};
    (vendas || []).forEach(v => {
      const dia = v.criado_em.split('T')[0];
      if (!porDia[dia]) porDia[dia] = { data: dia, total: 0, num_vendas: 0 };
      porDia[dia].total += v.total;
      porDia[dia].num_vendas++;
    });

    res.json({
      vendas: vendas || [],
      por_dia: Object.values(porDia),
      totais: {
        total: (vendas || []).reduce((s, v) => s + v.total, 0),
        num_vendas: vendas?.length || 0,
        ticket_medio: vendas?.length ? (vendas.reduce((s, v) => s + v.total, 0) / vendas.length) : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clientes-top', async (req, res) => {
  const { data } = await supabase.from('clientes')
    .select('nome, telefone, total_compras, num_compras, pontos, ultima_compra')
    .eq('loja_id', req.user.loja_id).eq('ativo', true)
    .order('total_compras', { ascending: false }).limit(20);
  res.json(data || []);
});

router.get('/crediario', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('crediario')
    .select('*, clientes(nome, telefone), vendas(numero)')
    .eq('loja_id', req.user.loja_id).order('criado_em', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json(data || []);
});

// POST /api/relatorios/crediario/:id/pagar — registra pagamento parcial ou total
router.post('/crediario/:id/pagar', async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, forma_pagamento, quitar } = req.body;
    const loja_id = req.user.loja_id;

    if (!valor || valor <= 0) return res.status(400).json({ error: 'Valor inválido' });

    const { data: cred, error: credErr } = await supabase
      .from('crediario').select('*').eq('id', id).eq('loja_id', loja_id).single();

    if (credErr || !cred) return res.status(404).json({ error: 'Crediário não encontrado' });
    if (cred.status === 'quitado') return res.status(400).json({ error: 'Crediário já quitado' });

    const novoSaldo = Math.max(0, (cred.saldo || 0) - valor);
    const novoPago = (cred.pago || 0) + valor;
    const quitado = novoSaldo <= 0.01 || quitar;
    const novoStatus = quitado ? 'quitado' : 'ativo';
    const novasParcPagas = quitado
      ? (cred.parcelas || 1)
      : Math.min((cred.parcelas_pagas || 0) + 1, cred.parcelas || 1);

    const { error: updErr } = await supabase.from('crediario').update({
      saldo: novoSaldo,
      pago: novoPago,
      status: novoStatus,
      parcelas_pagas: novasParcPagas
    }).eq('id', id);

    if (updErr) throw updErr;

    // Registra como movimentação financeira
    try {
      await supabase.from('movimentacoes').insert({
        loja_id,
        tipo: 'entrada',
        categoria: 'crediario',
        descricao: 'Recebimento crediário',
        valor,
        forma_pagamento: forma_pagamento || 'dinheiro'
      });
    } catch (_) {} // não bloqueia se movimentações não existir

    res.json({
      success: true,
      novo_saldo: novoSaldo,
      status: novoStatus,
      message: quitado ? 'Crediário quitado com sucesso!' : `Pagamento de R$${valor.toFixed(2).replace('.',',')} registrado`
    });
  } catch (err) {
    console.error('Erro pagamento crediário:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
