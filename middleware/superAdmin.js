const supabase = require('../utils/supabase');

/**
 * Restringe uma rota ao(s) super admin(s) da PLATAFORMA ComercioOS — ou
 * seja, você, o dono do SaaS. Isso é diferente do perfil 'admin' que já
 * existe: aquele é admin de UMA loja; este vê e gerencia TODAS as lojas.
 *
 * Busca a flag direto no banco a cada request (não confia em nada vindo
 * do JWT) — assim, revogar o acesso de alguém vale imediatamente.
 */
async function requireSuperAdmin(req, res, next) {
  try {
    const { data: usuario, error } = await supabase
      .from('usuarios').select('super_admin').eq('id', req.user.id).single();

    if (error || !usuario?.super_admin) {
      return res.status(403).json({ error: 'Acesso restrito ao administrador da plataforma' });
    }
    next();
  } catch (err) {
    console.error('Erro ao verificar super admin:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
}

module.exports = { requireSuperAdmin };
