const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// authMiddleware, verificarPlano e verificarPermissao('produtos') já são
// aplicados em server.js antes de montar essa rota.

const CAMPOS_PRODUTO = [
  'nome', 'marca', 'categoria_id', 'genero', 'preco_venda', 'preco_custo', 'descricao', 'ativo'
];

function sanitizarProduto(body) {
  const limpo = {};
  CAMPOS_PRODUTO.forEach(campo => {
    if (body[campo] !== undefined) limpo[campo] = body[campo];
  });
  return limpo;
}

function sanitizarVariacao(v) {
  return {
    tamanho: v.tamanho || null,
    cor: v.cor || null,
    estoque: Number(v.estoque) || 0,
    estoque_minimo: Number(v.estoque_minimo) || 5,
    codigo_barras: v.codigo_barras || null
  };
}

router.get('/', async (req, res) => {
  try {
    const { search, categoria_id, genero, ativo, page = 1 } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const paginaAtual = Math.max(1, Number(page) || 1);

    let query = supabase.from('produtos')
      .select('*, categorias(nome), variacoes(*)', { count: 'exact' })
      .eq('loja_id', req.user.loja_id)
      .order('criado_em', { ascending: false });

    if (search) query = query.ilike('nome', `%${search}%`);
    if (categoria_id) query = query.eq('categoria_id', categoria_id);
    if (genero) query = query.eq('genero', genero);
    if (ativo !== undefined) query = query.eq('ativo', ativo === 'true');

    const from = (paginaAtual - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: paginaAtual, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('produtos')
    .select('*, categorias(nome), variacoes(*)')
    .eq('id', req.params.id).eq('loja_id', req.user.loja_id).single();
  if (error) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(data);
});

router.post('/', async (req, res) => {
  try {
    const { variacoes } = req.body;
    const produtoData = sanitizarProduto(req.body);

    if (!produtoData.nome) return res.status(400).json({ error: 'Nome do produto é obrigatório' });
    if (!produtoData.preco_venda || produtoData.preco_venda <= 0) {
      return res.status(400).json({ error: 'Preço de venda deve ser maior que zero' });
    }

    const { data: produto, error } = await supabase.from('produtos')
      .insert({ ...produtoData, loja_id: req.user.loja_id }).select().single();
    if (error) throw error;

    if (variacoes && variacoes.length > 0) {
      await supabase.from('variacoes').insert(
        variacoes.map(v => ({ ...sanitizarVariacao(v), produto_id: produto.id }))
      );
    }

    const { data: completo } = await supabase.from('produtos')
      .select('*, categorias(nome), variacoes(*)').eq('id', produto.id).single();
    res.status(201).json(completo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { variacoes } = req.body;
    const produtoData = sanitizarProduto(req.body);

    const { data, error } = await supabase.from('produtos')
      .update({ ...produtoData, atualizado_em: new Date() })
      .eq('id', req.params.id).eq('loja_id', req.user.loja_id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Produto não encontrado' });

    if (variacoes) {
      await supabase.from('variacoes').delete().eq('produto_id', req.params.id);
      if (variacoes.length > 0) {
        await supabase.from('variacoes').insert(
          variacoes.map(v => ({ ...sanitizarVariacao(v), produto_id: req.params.id }))
        );
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('produtos')
    .update({ ativo: false }).eq('id', req.params.id).eq('loja_id', req.user.loja_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get('/categorias/lista', async (req, res) => {
  const { data } = await supabase.from('categorias')
    .select('*').eq('loja_id', req.user.loja_id).eq('ativa', true);
  res.json(data || []);
});

// GET /api/produtos/buscar-codigo/:codigo — usado pelo leitor de código de
// barras no PDV: aponta a câmera/scanner, o campo já busca e adiciona ao carrinho
router.get('/buscar-codigo/:codigo', async (req, res) => {
  const { data, error } = await supabase.from('variacoes')
    .select('id, tamanho, cor, estoque, codigo_barras, produtos!inner(id, nome, preco_venda, loja_id, ativo)')
    .eq('codigo_barras', req.params.codigo)
    .eq('produtos.loja_id', req.user.loja_id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Produto não encontrado para esse código' });
  if (!data.produtos.ativo) return res.status(404).json({ error: 'Produto inativo' });

  res.json({
    produto_id: data.produtos.id,
    variacao_id: data.id,
    nome: data.produtos.nome,
    preco_venda: data.produtos.preco_venda,
    tamanho: data.tamanho,
    cor: data.cor,
    estoque: data.estoque
  });
});

module.exports = router;
