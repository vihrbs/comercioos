const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const PLANO_VALOR = 59.99;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vihrbs.github.io/comercioos';

// GET /api/assinatura/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: loja } = await supabase
      .from('lojas')
      .select('status, trial_expires_at, mp_subscription_id')
      .eq('id', req.user.loja_id)
      .single();

    if (!loja) return res.status(404).json({ error: 'Loja não encontrada' });

    const agora = new Date();
    const trialExpira = loja.trial_expires_at ? new Date(loja.trial_expires_at) : null;
    const diasRestantes = trialExpira
      ? Math.max(0, Math.ceil((trialExpira - agora) / (1000 * 60 * 60 * 24)))
      : 0;

    let statusFinal = loja.status || 'trial';
    if (statusFinal === 'trial' && trialExpira && agora > trialExpira) {
      statusFinal = 'bloqueado';
      await supabase.from('lojas').update({ status: 'bloqueado' }).eq('id', req.user.loja_id);
    }

    res.json({
      status: statusFinal,
      trial_expires_at: loja.trial_expires_at,
      dias_restantes: diasRestantes,
      bloqueado: statusFinal === 'bloqueado'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assinatura/criar — Checkout Pro com PIX, boleto e cartão
router.post('/criar', authMiddleware, async (req, res) => {
  try {
    const { data: loja } = await supabase
      .from('lojas')
      .select('nome')
      .eq('id', req.user.loja_id)
      .single();

    // Checkout Pro — aceita PIX, boleto, cartão
    const preference = {
      items: [{
        id: 'comercioos-mensal',
        title: 'ComercioOS — Plano Mensal',
        description: `Assinatura mensal para ${loja?.nome || 'sua loja'}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: PLANO_VALOR
      }],
      payer: {
        email: req.user.email
      },
      payment_methods: {
        excluded_payment_types: [],
        installments: 1 // sem parcelamento
      },
      back_urls: {
        success: `${FRONTEND_URL}?pagamento=aprovado`,
        failure: `${FRONTEND_URL}?pagamento=falhou`,
        pending: `${FRONTEND_URL}?pagamento=pendente`
      },
      auto_return: 'approved',
      notification_url: `https://comercioos-production.up.railway.app/api/assinatura/webhook`,
      external_reference: req.user.loja_id, // para identificar a loja no webhook
      statement_descriptor: 'COMERCIOOS',
      expires: false
    };

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_TOKEN}`
      },
      body: JSON.stringify(preference)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || JSON.stringify(data));

    res.json({
      preference_id: data.id,
      init_point: data.init_point,       // produção
      sandbox_init_point: data.sandbox_init_point // testes
    });
  } catch (err) {
    console.error('Erro ao criar preference:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assinatura/webhook — MP notifica resultado do pagamento
router.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('Webhook MP recebido:', type, JSON.stringify(data));

    if (type === 'payment') {
      const paymentId = data?.id;
      if (!paymentId) return res.sendStatus(200);

      // Busca detalhes do pagamento no MP
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      const payment = await response.json();

      console.log('Pagamento MP:', payment.status, 'loja_id:', payment.external_reference);

      const lojaId = payment.external_reference;
      if (!lojaId) return res.sendStatus(200);

      if (payment.status === 'approved') {
        // Ativa a loja por 30 dias
        const proximoVencimento = new Date();
        proximoVencimento.setDate(proximoVencimento.getDate() + 30);

        await supabase.from('lojas').update({
          status: 'ativo',
          trial_expires_at: proximoVencimento.toISOString()
        }).eq('id', lojaId);

        // Registra o pagamento
        await supabase.from('pagamentos').insert({
          loja_id: lojaId,
          mp_subscription_id: String(paymentId),
          valor: payment.transaction_amount,
          status: 'aprovado',
          pago_em: new Date()
        });

        console.log(`✅ Loja ${lojaId} ativada até ${proximoVencimento.toISOString()}`);
      } else if (['rejected', 'cancelled'].includes(payment.status)) {
        console.log(`❌ Pagamento ${payment.status} para loja ${lojaId}`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook erro:', err);
    res.sendStatus(500);
  }
});

module.exports = router;
