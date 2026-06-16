const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/produtos
router.get('/', async (req, res) => {
  try {
    const { search, categoria_id, genero, ativo, page = 1, limit = 50 } = req.query;
    let query = supabase.from('produtos')
      .select('*, categorias(nome), variacoes(*)', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .order('criado_em', { ascending: false });

    if (search) query = query.ilike('nome', `%${search}%`);
    if (categoria_id) query = query.eq('categoria_id', categoria_id);
    if (genero) query = query.eq('genero', genero);
    if (ativo !== undefined) query = query.eq('ativo', ativo === 'true');

    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/produtos/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('produtos')
    .select('*, categorias(nome), variacoes(*)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(data);
});

// POST /api/produtos
router.post('/', async (req, res) => {
  try {
    const { variacoes, ...produtoData } = req.body;
    const { data: produto, error } = await supabase.from('produtos')
      .insert({ ...produtoData, loja_id: req.user.loja_id }).select().single();
    if (error) throw error;

    if (variacoes && variacoes.length > 0) {
      await supabase.from('variacoes').insert(
        variacoes.map(v => ({ ...v, produto_id: produto.id }))
      );
    }

    const { data: completo } = await supabase.from('produtos')
      .select('*, categorias(nome), variacoes(*)').eq('id', produto.id).single();
    res.status(201).json(completo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/produtos/:id
router.put('/:id', async (req, res) => {
  try {
    const { variacoes, ...produtoData } = req.body;
    const { data, error } = await supabase.from('produtos')
      .update({ ...produtoData, atualizado_em: new Date() })
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
    if (error) throw error;

    if (variacoes) {
      await supabase.from('variacoes').delete().eq('produto_id', req.params.id);
      if (variacoes.length > 0) {
        await supabase.from('variacoes').insert(
          variacoes.map(v => ({ ...v, produto_id: req.params.id }))
        );
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/produtos/:id (soft delete)
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('produtos')
    .update({ ativo: false }).eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/produtos/estoque/baixo
router.get('/estoque/baixo', async (req, res) => {
  const { data, error } = await supabase.from('variacoes')
    .select('*, produtos(nome, loja_id)')
    .filter('produtos.loja_id', 'eq', req.user.loja_id)
    .lt('estoque', supabase.raw('estoque_minimo'));
  res.json(data || []);
});

// GET /api/categorias
router.get('/categorias/lista', async (req, res) => {
  const { data } = await supabase.from('categorias')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativa', true);
  res.json(data || []);
});

module.exports = router;
