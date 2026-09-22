const supabase = require('../utils/supabase');

/**
 * Middleware de autorização por módulo.
 * Usar SEMPRE depois do authMiddleware (precisa de req.user.id e req.user.perfil).
 *
 * Busca as permissões direto no banco a cada requisição, em vez de confiar
 * no array que veio dentro do JWT — assim, se um admin revogar o acesso de
 * alguém a um módulo, isso vale na próxima requisição, sem esperar o token
 * expirar (o token dura 30 dias).
 *
 * Aceita um módulo único ou uma lista — se for lista, basta ter permissão
 * em UM dos módulos (útil pra rotas que atendem mais de uma tela do front,
 * ex: /api/vendas atende tanto o PDV quanto a tela de Vendas/Histórico).
 *
 * Uso:
 *   verificarPermissao('produtos')
 *   verificarPermissao(['pdv', 'vendas'])
 */
function verificarPermissao(moduloOuLista) {
  const modulos = Array.isArray(moduloOuLista) ? moduloOuLista : [moduloOuLista];

  return async (req, res, next) => {
    try {
      // Admin sempre tem acesso a tudo
      if (req.user.perfil === 'admin') return next();

      const { data: perm, error } = await supabase
        .from('usuario_permissoes')
        .select('permissoes')
        .eq('usuario_id', req.user.id)
        .maybeSingle();

      if (error) {
        console.error('Erro ao verificar permissão:', error.message);
        return res.status(500).json({ error: 'Erro ao verificar permissão' });
      }

      // Mesmo fallback usado no login/me: se não tem registro de permissão, usa o básico
      const permissoes = (perm && perm.permissoes && perm.permissoes.length > 0)
        ? perm.permissoes
        : ['dashboard', 'pdv', 'clientes'];

      const temAcesso = modulos.some(m => permissoes.includes(m));
      if (!temAcesso) {
        return res.status(403).json({ error: `Sem permissão para acessar "${modulos.join(' ou ')}"` });
      }

      next();
    } catch (err) {
      console.error('Erro no middleware de permissão:', err);
      res.status(500).json({ error: 'Erro interno' });
    }
  };
}

module.exports = { verificarPermissao };
