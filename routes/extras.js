const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/categorias', async (req, res) => {
  const { data } = await supabase.from('categorias')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativa', true).order('nome');
  res.json(data || []);
});

router.post('/categorias', async (req, res) => {
  const { data, error } = await supabase.from('categorias')
    .insert({ ...req.body, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/categorias/:id', async (req, res) => {
  const { data, error } = await supabase.from('categorias')
    .update(req.body).eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/categorias/:id', async (req, res) => {
  await supabase.from('categorias').update({ ativa: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

router.get('/pedidos', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('pedidos')
    .select('*, clientes(nome, telefone), funcionarios(nome)')
    .eq('loja_id', req.user.loja_id).order('criado_em', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json(data || []);
});

router.post('/pedidos', async (req, res) => {
  const { count } = await supabase.from('pedidos')
    .select('*', { count: 'exact', head: true }).eq('loja_id', req.user.loja_id);
  const numero = `P-${String((count || 0) + 1).padStart(5, '0')}`;
  const { data, error } = await supabase.from('pedidos')
    .insert({ ...req.body, loja_id: req.user.loja_id, numero }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/pedidos/:id', async (req, res) => {
  const { data, error } = await supabase.from('pedidos')
    .update({ ...req.body, atualizado_em: new Date() })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/loja', async (req, res) => {
  const { data } = await supabase.from('lojas').select('*').eq('id', req.user.loja_id).single();
  res.json(data);
});

router.put('/loja', async (req, res) => {
  const { data, error } = await supabase.from('lojas')
    .update({ ...req.body, atualizado_em: new Date() })
    .eq('id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
