const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../utils/supabase');
const { authMiddleware } = require('../middleware/auth');

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET; // pegue no painel do MP: Suas integrações > Webhooks > Chave secreta
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
        installments: 1
      },
      back_urls: {
        success: `${FRONTEND_URL}?pagamento=aprovado`,
        failure: `${FRONTEND_URL}?pagamento=falhou`,
        pending: `${FRONTEND_URL}?pagamento=pendente`
      },
      auto_return: 'approved',
      notification_url: `https://comercioos-production.up.railway.app/api/assinatura/webhook`,
      external_reference: req.user.loja_id,
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
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });
  } catch (err) {
    console.error('Erro ao criar preference:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Valida a assinatura do webhook do Mercado Pago (header x-signature).
 * Documentação do MP: Webhooks > Verificar a origem da notificação.
 *
 * Formato do header:  x-signature: ts=1712345678,v1=abcde123...
 * Manifesto assinado: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * (o <data.id> vem do QUERY STRING da URL de notificação, ex: ?data.id=123)
 *
 * IMPORTANTE: confirme esse formato contra a documentação atual do MP antes
 * de confiar 100% nisso em produção — a Mercado Pago já mudou esse esquema
 * de assinatura antes. Teste no sandbox e confira os logs.
 */
function validarAssinaturaMP(req) {
  if (!MP_WEBHOOK_SECRET) {
    console.warn('⚠️  MP_WEBHOOK_SECRET não configurado — pulando validação de assinatura!');
    return true; // não bloqueia se ainda não configurou, mas loga o alerta
  }

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature) return false;

  const partes = {};
  xSignature.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) partes[k.trim()] = v.trim();
  });
  const { ts, v1 } = partes;
  if (!ts || !v1) return false;

  const dataId = req.query['data.id'] || req.body?.data?.id || '';
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(v1));
}

// POST /api/assinatura/webhook — MP notifica resultado do pagamento
router.post('/webhook', async (req, res) => {
  try {
    // 1. Verifica se a notificação realmente vem do Mercado Pago
    if (!validarAssinaturaMP(req)) {
      console.warn('Webhook MP com assinatura inválida — ignorado');
      return res.sendStatus(401);
    }

    const { type, data } = req.body;
    console.log('Webhook MP recebido:', type, JSON.stringify(data));

    if (type === 'payment') {
      const paymentId = data?.id;
      if (!paymentId) return res.sendStatus(200);

      // 2. Idempotência: se esse payment_id já foi processado antes, ignora.
      // Sem isso, reenviar (replay) a mesma notificação estende a assinatura
      // por +30 dias de novo, de graça, quantas vezes quiser.
      const { data: jaProcessado } = await supabase.from('pagamentos')
        .select('id').eq('mp_subscription_id', String(paymentId)).maybeSingle();
      if (jaProcessado) {
        console.log(`Pagamento ${paymentId} já processado — ignorando repetição`);
        return res.sendStatus(200);
      }

      // Busca detalhes reais do pagamento na API do MP (nunca confia no body sozinho)
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      const payment = await response.json();

      console.log('Pagamento MP:', payment.status, 'loja_id:', payment.external_reference);

      const lojaId = payment.external_reference;
      if (!lojaId) return res.sendStatus(200);

      if (payment.status === 'approved') {
        const proximoVencimento = new Date();
        proximoVencimento.setDate(proximoVencimento.getDate() + 30);

        await supabase.from('lojas').update({
          status: 'ativo',
          trial_expires_at: proximoVencimento.toISOString()
        }).eq('id', lojaId);

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
