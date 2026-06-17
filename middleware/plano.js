const supabase = require('../utils/supabase');

const verificarPlano = async (req, res, next) => {
  try {
    const { data: loja } = await supabase
      .from('lojas')
      .select('status, trial_expires_at')
      .eq('id', req.user.loja_id)
      .single();

    if (!loja) return next(); // Se não achar, deixa passar

    const agora = new Date();
    const trialExpira = loja.trial_expires_at ? new Date(loja.trial_expires_at) : null;

    // Trial ativo
    if (loja.status === 'trial' && trialExpira && agora <= trialExpira) return next();

    // Assinatura ativa
    if (loja.status === 'ativo') return next();

    // Trial expirado ou bloqueado
    if (loja.status === 'trial' && trialExpira && agora > trialExpira) {
      await supabase.from('lojas').update({ status: 'bloqueado' }).eq('id', req.user.loja_id);
    }

    return res.status(402).json({
      error: 'Acesso bloqueado',
      code: 'PLANO_EXPIRADO',
      message: 'Seu período de teste expirou. Assine o ComercioOS para continuar.'
    });
  } catch (err) {
    next(); // Em caso de erro, não bloqueia
  }
};

module.exports = { verificarPlano };
