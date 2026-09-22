const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');
const { verificarPermissao } = require('../middleware/permissao');

router.use(authMiddleware);

function sanitizarBody(body, camposPermitidos) {
  const limpo = {};
  camposPermitidos.forEach(campo => {
    if (body[campo] !== undefined) limpo[campo] = body[campo];
  });
  return limpo;
}

// ============ CATEGORIAS ============
router.get('/categorias', verificarPermissao('produtos'), async (req, res) => {
  const { data } = await supabase.from('categorias')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativa', true).order('nome');
  res.json(data || []);
});

router.post('/categorias', verificarPermissao('produtos'), async (req, res) => {
  const dados = sanitizarBody(req.body, ['nome']);
  if (!dados.nome) return res.status(400).json({ error: 'Nome obrigatório' });

  const { data, error } = await supabase.from('categorias')
    .insert({ ...dados, loja_id: req.user.loja_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/categorias/:id', verificarPermissao('produtos'), async (req, res) => {
  const dados = sanitizarBody(req.body, ['nome', 'ativa']);

  const { data, error } = await supabase.from('categorias')
    .update(dados).eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/categorias/:id', verificarPermissao('produtos'), async (req, res) => {
  await supabase.from('categorias').update({ ativa: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

// ============ PEDIDOS ============
router.get('/pedidos', verificarPermissao('pedidos'), async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('pedidos')
    .select('*, clientes(nome, telefone), funcionarios(nome)')
    .eq('loja_id', req.user.loja_id).order('criado_em', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  res.json(data || []);
});

router.post('/pedidos', verificarPermissao('pedidos'), async (req, res) => {
  const dados = sanitizarBody(req.body, [
    'cliente_id', 'funcionario_id', 'tipo', 'itens', 'total', 'observacoes', 'status'
  ]);

  const { count } = await supabase.from('pedidos')
    .select('*', { count: 'exact', head: true }).eq('loja_id', req.user.loja_id);
  const numero = `P-${String((count || 0) + 1).padStart(5, '0')}`;

  const { data, error } = await supabase.from('pedidos')
    .insert({ ...dados, loja_id: req.user.loja_id, numero }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/pedidos/:id', verificarPermissao('pedidos'), async (req, res) => {
  const dados = sanitizarBody(req.body, [
    'cliente_id', 'funcionario_id', 'tipo', 'itens', 'total', 'observacoes', 'status'
  ]);

  const { data, error } = await supabase.from('pedidos')
    .update({ ...dados, atualizado_em: new Date() })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============ LOJA (dados cadastrais) ============
router.get('/loja', async (req, res) => {
  const { data } = await supabase.from('lojas').select('*').eq('id', req.user.loja_id).single();
  res.json(data);
});

router.put('/loja', async (req, res) => {
  if (req.user.perfil !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem editar dados da loja' });
  }

  // Whitelist estrita: NUNCA aceitar plano, status de assinatura, trial_expires_at,
  // limites de uso, etc. vindos do body do cliente.
  const dados = sanitizarBody(req.body, [
    'nome', 'tipo', 'cnpj', 'telefone', 'email', 'endereco', 'cidade', 'estado'
  ]);

  const { data, error } = await supabase.from('lojas')
    .update({ ...dados, atualizado_em: new Date() })
    .eq('id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
