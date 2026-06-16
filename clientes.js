const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/clientes
router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    let query = supabase.from('clientes')
      .select('*', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .eq('ativo', true)
      .order('nome');

    if (search) {
      query = query.or(`nome.ilike.%${search}%,email.ilike.%${search}%,telefone.ilike.%${search}%,cpf.ilike.%${search}%`);
    }

    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clientes/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('clientes')
    .select('*').eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Cliente não encontrado' });

  // Histórico de compras
  const { data: vendas } = await supabase.from('vendas')
    .select('id, numero, total, forma_pagamento, status, criado_em')
    .eq('cliente_id', req.params.id)
    .order('criado_em', { ascending: false })
    .limit(20);

  res.json({ ...data, historico_vendas: vendas || [] });
});

// POST /api/clientes
router.post('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('clientes')
      .insert({ ...req.body, loja_id: req.user.loja_id }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/clientes/:id
router.put('/:id', async (req, res) => {
  const { data, error } = await supabase.from('clientes')
    .update({ ...req.body, atualizado_em: new Date() })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/clientes/:id
router.delete('/:id', async (req, res) => {
  await supabase.from('clientes').update({ ativo: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

// GET /api/clientes/:id/crediario
router.get('/:id/crediario', async (req, res) => {
  const { data } = await supabase.from('crediario')
    .select('*, vendas(numero)').eq('cliente_id', req.params.id)
    .order('criado_em', { ascending: false });
  res.json(data || []);
});

module.exports = router;
