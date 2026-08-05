const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

const TODOS_MODULOS = ['dashboard','pdv','produtos','estoque','clientes','pedidos','vendas','financeiro','crediario','funcionarios','comissoes','relatorios','config'];

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { nome_loja, nome, email, senha, telefone, tipo } = req.body;
    if (!nome_loja || !nome || !email || !senha) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const { data: existente } = await supabase
      .from('usuarios').select('id').eq('email', email).single();
    if (existente) return res.status(409).json({ error: 'Email já cadastrado' });

    const trialExpira = new Date();
    trialExpira.setDate(trialExpira.getDate() + 14);

    const { data: loja, error: lojaErr } = await supabase
      .from('lojas').insert({
        nome: nome_loja, tipo: tipo || 'moda', telefone: telefone || null,
        status: 'trial', trial_expires_at: trialExpira.toISOString()
      }).select().single();
    if (lojaErr) throw lojaErr;

    const senha_hash = await bcrypt.hash(senha, 10);
    const { data: usuario, error: userErr } = await supabase
      .from('usuarios').insert({
        loja_id: loja.id, nome, email, senha_hash, perfil: 'admin', ativo: true
      }).select().single();
    if (userErr) throw userErr;

    // Categorias padrão
    await supabase.from('categorias').insert(
      ['Feminino','Masculino','Infantil','Acessórios','Calçados'].map(n => ({ loja_id: loja.id, nome: n }))
    );

    const token = jwt.sign(
      { id: usuario.id, loja_id: loja.id, nome, email, perfil: 'admin' },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );

    // Telegram
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
    if (TG_TOKEN && TG_CHAT) {
      try {
        const msg = `🎉 Novo cadastro no ComercioOS!\n\n🏪 Loja: ${nome_loja}\n👤 Responsável: ${nome}\n📧 Email: ${email}\n📱 Telefone: ${telefone || 'não informado'}\n📅 ${new Date().toLocaleString('pt-BR')}`;
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT, text: msg })
        });
      } catch (e) { console.error('Telegram erro:', e.message); }
    }

    res.status(201).json({
      token,
      usuario: { id: usuario.id, nome, email, perfil: 'admin', permissoes: TODOS_MODULOS },
      loja
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/login
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

    // Busca permissões do banco — SEMPRE (nunca só do perfil)
    let permissoes = TODOS_MODULOS; // padrão admin
    if (usuario.perfil !== 'admin') {
      try {
        const { data: perm } = await supabase
          .from('usuario_permissoes')
          .select('permissoes')
          .eq('usuario_id', usuario.id)
          .maybeSingle();
        permissoes = (perm && perm.permissoes && perm.permissoes.length > 0)
          ? perm.permissoes
          : ['dashboard', 'pdv', 'clientes'];
      } catch (e) {
        permissoes = ['dashboard', 'pdv', 'clientes'];
      }
    }

    const token = jwt.sign(
      { id: usuario.id, loja_id: usuario.loja_id, nome: usuario.nome, email, perfil: usuario.perfil },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );

    res.json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email, perfil: usuario.perfil, permissoes, cargo: usuario.cargo || null },
      loja: usuario.lojas
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: usuario } = await supabase
      .from('usuarios').select('*, lojas(*)').eq('id', req.user.id).single();

    let permissoes = TODOS_MODULOS;
    if (usuario.perfil !== 'admin') {
      try {
        const { data: perm } = await supabase
          .from('usuario_permissoes').select('permissoes')
          .eq('usuario_id', usuario.id).maybeSingle();
        permissoes = (perm && perm.permissoes && perm.permissoes.length > 0)
          ? perm.permissoes : ['dashboard','pdv','clientes'];
      } catch (e) { permissoes = ['dashboard','pdv','clientes']; }
    }

    res.json({ ...usuario, permissoes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/usuarios — lista usuários da loja
router.get('/usuarios', authMiddleware, async (req, res) => {
  try {
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('id, nome, email, perfil, cargo, ativo, ultimo_acesso')
      .eq('loja_id', req.user.loja_id)
      .order('criado_em');

    // Busca permissões de cada usuário
    const { data: perms } = await supabase
      .from('usuario_permissoes')
      .select('usuario_id, permissoes')
      .eq('loja_id', req.user.loja_id);

    const permMap = {};
    (perms || []).forEach(p => { permMap[p.usuario_id] = p.permissoes; });

    const result = (usuarios || []).map(u => ({
      ...u,
      permissoes: u.perfil === 'admin' ? TODOS_MODULOS : (permMap[u.id] || [])
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/usuarios — cria usuário da loja (só admin)
router.post('/usuarios', authMiddleware, async (req, res) => {
  try {
    if (req.user.perfil !== 'admin') return res.status(403).json({ error: 'Acesso negado' });

    const { nome, email, senha, cargo, perfil, permissoes } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });
    if (senha.length < 6) return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });

    const { data: existente } = await supabase
      .from('usuarios').select('id').eq('email', email).single();
    if (existente) return res.status(409).json({ error: 'Email já cadastrado' });

    const senha_hash = await bcrypt.hash(senha, 10);
    const { data: usuario, error } = await supabase
      .from('usuarios').insert({
        loja_id: req.user.loja_id, nome, email, senha_hash,
        perfil: perfil || 'custom', cargo: cargo || null, ativo: true
      }).select().single();
    if (error) throw error;

    // Salva permissões
    const permsFinais = perfil === 'admin' ? TODOS_MODULOS : (permissoes || ['dashboard','pdv','clientes']);
    try {
      await supabase.from('usuario_permissoes').insert({
        usuario_id: usuario.id,
        loja_id: req.user.loja_id,
        permissoes: permsFinais
      });
    } catch (e) { console.error('Erro ao salvar permissões:', e.message); }

    res.status(201).json({ ...usuario, permissoes: permsFinais });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/usuarios/:id/permissoes — atualiza permissões
router.put('/usuarios/:id/permissoes', authMiddleware, async (req, res) => {
  try {
    if (req.user.perfil !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    const { permissoes } = req.body;
    if (!permissoes || !permissoes.length) return res.status(400).json({ error: 'Permissões obrigatórias' });

    const { error } = await supabase
      .from('usuario_permissoes')
      .upsert({ usuario_id: req.params.id, loja_id: req.user.loja_id, permissoes }, { onConflict: 'usuario_id' });
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/usuarios/:id — remove usuário
router.delete('/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.perfil !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });

    await supabase.from('usuarios').update({ ativo: false }).eq('id', req.params.id).eq('loja_id', req.user.loja_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
