const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.use(authMiddleware);

// ======== FUNCIONÁRIOS ========
router.get('/funcionarios', async (req, res) => {
  const { data } = await supabase.from('funcionarios')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativo', true).order('nome');
  res.json(data || []);
});

router.get('/funcionarios/:id', async (req, res) => {
  const { data, error } = await supabase.from('funcionarios')
    .select('*').eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Funcionário não encontrado' });
  res.json(data);
});

router.post('/funcionarios', async (req, res) => {
  const { data, error } = await supabase.from('funcionarios')
    .insert({ ...req.body, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/funcionarios/:id', async (req, res) => {
  const { data, error } = await supabase.from('funcionarios')
    .update(req.body).eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/funcionarios/:id', async (req, res) => {
  await supabase.from('funcionarios').update({ ativo: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

// GET /funcionarios/:id/comissoes - Comissões do funcionário no período
router.get('/funcionarios/:id/comissoes', async (req, res) => {
  const { mes, ano } = req.query;
  const inicioMes = `${ano || new Date().getFullYear()}-${String(mes || new Date().getMonth() + 1).padStart(2,'0')}-01`;
  const fimMes = new Date(ano || new Date().getFullYear(), mes || new Date().getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: func } = await supabase.from('funcionarios')
    .select('nome, comissao_pct, meta_mensal').eq('id', req.params.id).single();

  const { data: vendas } = await supabase.from('vendas')
    .select('total, criado_em').eq('funcionario_id', req.params.id)
    .eq('status', 'finalizada').gte('criado_em', inicioMes).lte('criado_em', fimMes + 'T23:59:59');

  const totalVendas = (vendas || []).reduce((s, v) => s + v.total, 0);
  const comissao = totalVendas * ((func?.comissao_pct || 0) / 100);

  res.json({
    funcionario: func,
    periodo: { mes, ano },
    total_vendas: totalVendas,
    num_vendas: vendas?.length || 0,
    comissao_valor: comissao,
    meta_mensal: func?.meta_mensal || 0,
    meta_atingida: totalVendas >= (func?.meta_mensal || 0),
    percentual_meta: func?.meta_mensal ? (totalVendas / func.meta_mensal * 100).toFixed(1) : 0,
    vendas: vendas || []
  });
});

// ======== CAIXA ========
router.get('/caixa/atual', async (req, res) => {
  const { data } = await supabase.from('caixas')
    .select('*, funcionarios(nome)').eq('loja_id', req.user.loja_id)
    .eq('status', 'aberto').order('aberto_em', { ascending: false }).limit(1).single();
  res.json(data || null);
});

router.post('/caixa/abrir', async (req, res) => {
  const { saldo_inicial, funcionario_id } = req.body;
  const { data: caixaAberto } = await supabase.from('caixas')
    .select('id').eq('loja_id', req.user.loja_id).eq('status', 'aberto').single();
  if (caixaAberto) return res.status(409).json({ error: 'Já existe um caixa aberto' });

  const { data, error } = await supabase.from('caixas').insert({
    loja_id: req.user.loja_id,
    funcionario_id: funcionario_id || null,
    saldo_inicial: saldo_inicial || 0
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.post('/caixa/fechar', async (req, res) => {
  try {
    const { caixa_id, saldo_final, observacoes } = req.body;
    const { data: caixa } = await supabase.from('caixas').select('*').eq('id', caixa_id).single();
    if (!caixa) return res.status(404).json({ error: 'Caixa não encontrado' });

    // Calcula totais por forma de pagamento
    const { data: movs } = await supabase.from('movimentacoes')
      .select('valor, forma_pagamento').eq('caixa_id', caixa_id).eq('tipo', 'entrada');

    const totais = (movs || []).reduce((acc, m) => {
      acc[m.forma_pagamento] = (acc[m.forma_pagamento] || 0) + m.valor;
      acc.total += m.valor;
      return acc;
    }, { total: 0, dinheiro: 0, pix: 0, debito: 0, credito: 0, crediario: 0 });

    await supabase.from('caixas').update({
      status: 'fechado',
      saldo_final: saldo_final || 0,
      total_vendas: totais.total,
      total_dinheiro: totais.dinheiro,
      total_pix: totais.pix,
      total_debito: totais.debito,
      total_credito: totais.credito,
      total_crediario: totais.crediario,
      fechado_em: new Date(),
      observacoes
    }).eq('id', caixa_id);

    res.json({ success: true, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/caixa/sangria', async (req, res) => {
  const { caixa_id, valor, descricao } = req.body;
  const { data, error } = await supabase.from('movimentacoes').insert({
    loja_id: req.user.loja_id, caixa_id,
    tipo: 'saida', categoria: 'sangria',
    descricao: descricao || 'Sangria de caixa',
    valor, forma_pagamento: 'dinheiro'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ======== FINANCEIRO ========
router.get('/movimentacoes', async (req, res) => {
  const { data_inicio, data_fim, tipo, page = 1, limit = 50 } = req.query;
  let query = supabase.from('movimentacoes').select('*', { count: 'exact' })
    .eq('loja_id', req.user.loja_id).order('criado_em', { ascending: false });
  if (tipo) query = query.eq('tipo', tipo);
  if (data_inicio) query = query.gte('criado_em', data_inicio);
  if (data_fim) query = query.lte('criado_em', data_fim + 'T23:59:59');
  query = query.range((page - 1) * limit, page * limit - 1);
  const { data, count } = await query;
  res.json({ data, total: count });
});

router.post('/movimentacoes', async (req, res) => {
  const { data, error } = await supabase.from('movimentacoes')
    .insert({ ...req.body, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
