const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { verificarPermissao } = require('../middleware/permissao');

// authMiddleware e verificarPlano já são aplicados em server.js.
// Aqui dentro cada rota exige o módulo certo: funcionarios/comissoes ou financeiro.

const CAMPOS_FUNCIONARIO = ['nome', 'cargo', 'email', 'telefone', 'salario_base', 'comissao_pct', 'meta_mensal', 'data_admissao', 'ativo'];
function sanitizarFuncionario(body) {
  const limpo = {};
  CAMPOS_FUNCIONARIO.forEach(c => { if (body[c] !== undefined) limpo[c] = body[c]; });
  return limpo;
}

const CAMPOS_MOVIMENTACAO = ['tipo', 'categoria', 'descricao', 'valor', 'forma_pagamento', 'caixa_id', 'referencia_id'];
function sanitizarMovimentacao(body) {
  const limpo = {};
  CAMPOS_MOVIMENTACAO.forEach(c => { if (body[c] !== undefined) limpo[c] = body[c]; });
  return limpo;
}

router.get('/funcionarios', verificarPermissao('funcionarios'), async (req, res) => {
  const { data } = await supabase.from('funcionarios')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativo', true).order('nome');
  res.json(data || []);
});

router.get('/funcionarios/:id', verificarPermissao('funcionarios'), async (req, res) => {
  const { data, error } = await supabase.from('funcionarios')
    .select('*').eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Funcionário não encontrado' });
  res.json(data);
});

router.post('/funcionarios', verificarPermissao('funcionarios'), async (req, res) => {
  const dados = sanitizarFuncionario(req.body);
  if (!dados.nome) return res.status(400).json({ error: 'Nome obrigatório' });

  const { data, error } = await supabase.from('funcionarios')
    .insert({ ...dados, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/funcionarios/:id', verificarPermissao('funcionarios'), async (req, res) => {
  const dados = sanitizarFuncionario(req.body);
  const { data, error } = await supabase.from('funcionarios')
    .update(dados).eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/funcionarios/:id', verificarPermissao('funcionarios'), async (req, res) => {
  await supabase.from('funcionarios').update({ ativo: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

router.get('/funcionarios/:id/comissoes', verificarPermissao(['funcionarios', 'comissoes']), async (req, res) => {
  const { mes, ano } = req.query;
  const inicioMes = `${ano || new Date().getFullYear()}-${String(mes || new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const fimMes = new Date(ano || new Date().getFullYear(), mes || new Date().getMonth() + 1, 0).toISOString().split('T')[0];

  // SEMPRE filtra por loja_id — sem isso, qualquer usuário logado (de
  // qualquer loja) consegue ver nome, % de comissão e meta de funcionário
  // de outra loja, só sabendo o UUID.
  const { data: func } = await supabase.from('funcionarios')
    .select('nome, comissao_pct, meta_mensal')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (!func) return res.status(404).json({ error: 'Funcionário não encontrado' });

  const { data: vendas } = await supabase.from('vendas')
    .select('total, criado_em')
    .eq('funcionario_id', req.params.id).eq('loja_id', req.user.loja_id)
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

router.get('/caixa/atual', verificarPermissao('financeiro'), async (req, res) => {
  const { data } = await supabase.from('caixas')
    .select('*, funcionarios(nome)').eq('loja_id', req.user.loja_id)
    .eq('status', 'aberto').order('aberto_em', { ascending: false }).limit(1).single();
  res.json(data || null);
});

router.post('/caixa/abrir', verificarPermissao('financeiro'), async (req, res) => {
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

router.post('/caixa/fechar', verificarPermissao('financeiro'), async (req, res) => {
  try {
    const { caixa_id, saldo_final, observacoes } = req.body;

    // SEMPRE filtra por loja_id — sem isso, qualquer usuário logado
    // conseguiria fechar o caixa de outra loja remotamente.
    const { data: caixa } = await supabase.from('caixas').select('*')
      .eq('id', caixa_id).eq('loja_id', req.user.loja_id).single();
    if (!caixa) return res.status(404).json({ error: 'Caixa não encontrado' });
    if (caixa.status === 'fechado') return res.status(400).json({ error: 'Caixa já está fechado' });

    const { data: movs } = await supabase.from('movimentacoes')
      .select('valor, forma_pagamento')
      .eq('caixa_id', caixa_id).eq('loja_id', req.user.loja_id).eq('tipo', 'entrada');

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
    }).eq('id', caixa_id).eq('loja_id', req.user.loja_id);

    res.json({ success: true, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/caixa/sangria', verificarPermissao('financeiro'), async (req, res) => {
  const { caixa_id, valor, descricao } = req.body;
  if (!valor || valor <= 0) return res.status(400).json({ error: 'Valor inválido' });

  // Confirma que o caixa informado é realmente da loja de quem está pedindo,
  // antes de vincular a sangria a ele (evita referência cruzada entre lojas)
  if (caixa_id) {
    const { data: caixa } = await supabase.from('caixas')
      .select('id').eq('id', caixa_id).eq('loja_id', req.user.loja_id).single();
    if (!caixa) return res.status(404).json({ error: 'Caixa não encontrado' });
  }

  const { data, error } = await supabase.from('movimentacoes').insert({
    loja_id: req.user.loja_id, caixa_id: caixa_id || null,
    tipo: 'saida', categoria: 'sangria',
    descricao: descricao || 'Sangria de caixa',
    valor, forma_pagamento: 'dinheiro'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.get('/movimentacoes', verificarPermissao('financeiro'), async (req, res) => {
  const { data_inicio, data_fim, tipo, page = 1 } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  let query = supabase.from('movimentacoes').select('*', { count: 'exact' })
    .eq('loja_id', req.user.loja_id).order('criado_em', { ascending: false });
  if (tipo) query = query.eq('tipo', tipo);
  if (data_inicio) query = query.gte('criado_em', data_inicio);
  if (data_fim) query = query.lte('criado_em', data_fim + 'T23:59:59');
  const paginaAtual = Math.max(1, Number(page) || 1);
  query = query.range((paginaAtual - 1) * limit, paginaAtual * limit - 1);
  const { data, count } = await query;
  res.json({ data, total: count });
});

router.post('/movimentacoes', verificarPermissao('financeiro'), async (req, res) => {
  const dados = sanitizarMovimentacao(req.body);
  const { data, error } = await supabase.from('movimentacoes')
    .insert({ ...dados, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
