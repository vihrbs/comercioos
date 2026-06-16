const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

router.post('/register', async (req, res) => {
  try {
    const { nome_loja, nome, email, senha, tipo } = req.body;
    if (!nome_loja || !nome || !email || !senha) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const { data: existente } = await supabase
      .from('usuarios').select('id').eq('email', email).single();
    if (existente) return res.status(409).json({ error: 'Email já cadastrado' });

    const { data: loja, error: lojaErr } = await supabase
      .from('lojas').insert({ nome: nome_loja, tipo: tipo || 'moda' }).select().single();
    if (lojaErr) throw lojaErr;

    const senha_hash = await bcrypt.hash(senha, 10);
    const { data: usuario, error: userErr } = await supabase
      .from('usuarios').insert({
        loja_id: loja.id, nome, email, senha_hash, perfil: 'admin'
      }).select().single();
    if (userErr) throw userErr;

    const categoriasPadrao = ['Feminino', 'Masculino', 'Infantil', 'Acessórios', 'Calçados'];
    await supabase.from('categorias').insert(
      categoriasPadrao.map(nome => ({ loja_id: loja.id, nome }))
    );

    const token = jwt.sign(
      { id: usuario.id, loja_id: loja.id, nome, email, perfil: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, usuario: { id: usuario.id, nome, email, perfil: 'admin' }, loja });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const { data: usuario, error } = await supabase
      .from('usuarios').select('*, lojas(*)').eq('email', email).eq('ativo', true).single();
    if (error || !usuario) return res.status(401).json({ error: 'Credenciais inválidas' });

    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ error: 'Credenciais inválidas' });

    await supabase.from('usuarios').update({ ultimo_acesso: new Date() }).eq('id', usuario.id);

    const token = jwt.sign(
      { id: usuario.id, loja_id: usuario.loja_id, nome: usuario.nome, email, perfil: usuario.perfil },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email, perfil: usuario.perfil },
      loja: usuario.lojas
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  const { data: usuario } = await supabase
    .from('usuarios').select('*, lojas(*)').eq('id', req.user.id).single();
  res.json(usuario);
});

module.exports = router;
