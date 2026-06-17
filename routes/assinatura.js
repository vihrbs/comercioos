const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const PLANO_VALOR = 59.99;
const PLANO_NOME = 'ComercioOS — Plano Mensal';

// GET /api/assinatura/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: loja } = await supabase
      .from('lojas')
      .select('status, trial_expires_at, mp_subscription_id, nome')
      .eq('id', req.user.loja_id)
      .single();

    if (!loja) return res.status(404).json({ error: 'Loja não encontrada' });

    const agora = new Date();
    const trialExpira = loja.trial_expires_at ? new Date(loja.trial_expires_at) : null;
    const diasRestantes = trialExpira ? Math.max(0, Math.ceil((trialExpira - agora) / (1000 * 60 * 60 * 24))) : 0;

    let statusFinal = loja.status || 'trial';
    if (statusFinal === 'trial' && trialExpira && agora > trialExpira) {
      statusFinal = 'bloqueado';
      await supabase.from('lojas').update({ status: 'bloqueado' }).eq('id', req.user.loja_id);
    }

    res.json({
      status: statusFinal,
      trial_expires_at: loja.trial_expires_at,
      dias_restantes: diasRestantes,
      mp_subscription_id: loja.mp_subscription_id,
      bloqueado: statusFinal === 'bloqueado'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assinatura/criar — cria assinatura recorrente no MP
router.post('/criar', authMiddleware, async (req, res) => {
  try {
    const { data: loja } = await supabase
      .from('lojas').select('nome, mp_subscription_id').eq('id', req.user.loja_id).single();

    // Cria preapproval (assinatura recorrente) no Mercado Pago
    const body = {
      reason: PLANO_NOME,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: PLANO_VALOR,
        currency_id: 'BRL'
      },
      back_url: process.env.FRONTEND_URL || 'https://vihrbs.github.io/comercioos',
      payer_email: req.user.email,
      status: 'pending'
    };

    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_TOKEN}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erro ao criar assinatura no MP');

    // Salva o ID da assinatura na loja
    await supabase.from('lojas')
      .update({ mp_subscription_id: data.id })
      .eq('id', req.user.loja_id);

    res.json({
      subscription_id: data.id,
      init_point: data.init_point, // URL de pagamento do MP
      status: data.status
    });
  } catch (err) {
    console.error('Erro assinatura:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assinatura/webhook — MP notifica pagamento
router.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('Webhook MP:', type, data);

    if (type === 'subscription_preapproval') {
      const subId = data?.id;
      if (!subId) return res.sendStatus(200);

      // Busca detalhes da assinatura no MP
      const response = await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      const sub = await response.json();

      const { data: loja } = await supabase
        .from('lojas').select('id').eq('mp_subscription_id', subId).single();

      if (loja) {
        let novoStatus = 'trial';
        if (sub.status === 'authorized') novoStatus = 'ativo';
        else if (['cancelled', 'paused'].includes(sub.status)) novoStatus = 'bloqueado';

        await supabase.from('lojas')
          .update({ status: novoStatus })
          .eq('id', loja.id);

        // Registra pagamento
        if (sub.status === 'authorized') {
          await supabase.from('pagamentos').insert({
            loja_id: loja.id,
            mp_subscription_id: subId,
            valor: PLANO_VALOR,
            status: 'aprovado',
            pago_em: new Date()
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook erro:', err);
    res.sendStatus(500);
  }
});

module.exports = router;
