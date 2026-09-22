const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// authMiddleware, verificarPlano e verificarPermissao('clientes') já são
// aplicados em server.js antes de montar essa rota.

const CAMPOS_CLIENTE = ['nome', 'cpf', 'email', 'telefone', 'data_nascimento', 'genero', 'observacoes', 'ativo'];
function sanitizarCliente(body) {
  const limpo = {};
  CAMPOS_CLIENTE.forEach(c => { if (body[c] !== undefined) limpo[c] = body[c]; });
  return limpo;
}

// Remove caracteres que têm significado especial na sintaxe de filtro do
// PostgREST (.or() usa "," para separar condições e "()" para agrupar) —
// sem isso, uma busca com esses caracteres pode alterar a lógica do filtro.
function sanitizarBusca(texto) {
  return String(texto).replace(/[,()]/g, ' ').trim();
}

router.get('/', async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    let query = supabase.from('clientes')
      .select('*', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .eq('ativo', true)
      .order('nome');

    if (search) {
      const termo = sanitizarBusca(search);
      if (termo) {
        query = query.or(`nome.ilike.%${termo}%,email.ilike.%${termo}%,telefone.ilike.%${termo}%,cpf.ilike.%${termo}%`);
      }
    }

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

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('clientes')
    .select('*').eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { data: vendas } = await supabase.from('vendas')
    .select('id, numero, total, forma_pagamento, status, criado_em')
    .eq('cliente_id', req.params.id).eq('loja_id', req.user.loja_id)
    .order('criado_em', { ascending: false })
    .limit(20);

  res.json({ ...data, historico_vendas: vendas || [] });
});

router.post('/', async (req, res) => {
  try {
    const dados = sanitizarCliente(req.body);
    if (!dados.nome) return res.status(400).json({ error: 'Nome obrigatório' });

    const { data, error } = await supabase.from('clientes')
      .insert({ ...dados, loja_id: req.user.loja_id }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const dados = sanitizarCliente(req.body);
  const { data, error } = await supabase.from('clientes')
    .update({ ...dados, atualizado_em: new Date() })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  await supabase.from('clientes').update({ ativo: false })
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  res.json({ success: true });
});

router.get('/:id/crediario', async (req, res) => {
  // Confirma que o cliente pertence à loja de quem está pedindo, ANTES de
  // buscar o crediário. Sem isso, qualquer usuário logado (de qualquer loja)
  // conseguia ver o histórico financeiro de cliente de outra loja só
  // sabendo/adivinhando o UUID.
  const { data: cliente } = await supabase.from('clientes')
    .select('id').eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { data } = await supabase.from('crediario')
    .select('*, vendas(numero)').eq('cliente_id', req.params.id)
    .order('criado_em', { ascending: false });
  res.json(data || []);
});

module.exports = router;
