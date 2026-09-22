const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// authMiddleware + requireSuperAdmin já aplicados em server.js.
// Essas rotas NÃO filtram por loja_id de propósito — é o painel de quem
// opera a plataforma inteira, não de uma loja específica.

router.get('/lojas', async (req, res) => {
  try {
    const { search, status, page = 1 } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const paginaAtual = Math.max(1, Number(page) || 1);

    let query = supabase.from('lojas')
      .select('id, nome, tipo, status, trial_expires_at, criado_em, telefone', { count: 'exact' })
      .order('criado_em', { ascending: false });

    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('nome', `%${search}%`);

    query = query.range((paginaAtual - 1) * limit, paginaAtual * limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/lojas/:id', async (req, res) => {
  try {
    const { data: loja, error } = await supabase.from('lojas').select('*').eq('id', req.params.id).single();
    if (error || !loja) return res.status(404).json({ error: 'Loja não encontrada' });

    const { count: numUsuarios } = await supabase.from('usuarios')
      .select('*', { count: 'exact', head: true }).eq('loja_id', req.params.id);
    const { count: numVendas } = await supabase.from('vendas')
      .select('*', { count: 'exact', head: true }).eq('loja_id', req.params.id);
    const { data: ultimoPagamento } = await supabase.from('pagamentos')
      .select('*').eq('loja_id', req.params.id).order('pago_em', { ascending: false }).limit(1).maybeSingle();

    res.json({ ...loja, num_usuarios: numUsuarios || 0, num_vendas: numVendas || 0, ultimo_pagamento: ultimoPagamento || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Ajuste manual de status — pra você usar quando um cliente pagar por
 * fora, pedir extensão de trial de cortesia, ou precisar bloquear/desbloquear
 * manualmente por qualquer motivo de suporte.
 */
router.put('/lojas/:id/status', async (req, res) => {
  try {
    const { status, trial_expires_at, motivo } = req.body;
    if (!['trial', 'ativo', 'bloqueado'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    const dados = { status };
    if (trial_expires_at) dados.trial_expires_at = trial_expires_at;

    const { data, error } = await supabase.from('lojas')
      .update(dados).eq('id', req.params.id).select().single();
    if (error) throw error;

    console.log(`[ADMIN] Loja ${req.params.id} -> status "${status}" por usuário ${req.user.id}. Motivo: ${motivo || '—'}`);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { data: lojas } = await supabase.from('lojas').select('status, criado_em');
    const porStatus = {};
    (lojas || []).forEach(l => { porStatus[l.status] = (porStatus[l.status] || 0) + 1; });

    const PLANO_VALOR = 59.99;
    const mrrEstimado = (porStatus.ativo || 0) * PLANO_VALOR;

    const trintaDiasAtras = new Date(Date.now() - 30 * 86400000);
    const novasUltimos30 = (lojas || []).filter(l => new Date(l.criado_em) >= trintaDiasAtras).length;

    res.json({
      total_lojas: (lojas || []).length,
      por_status: porStatus,
      mrr_estimado: mrrEstimado,
      novas_ultimos_30_dias: novasUltimos30
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/alertas — resumo do que precisa de atenção: trials
// acabando nos próximos 7 dias, e lojas já bloqueadas
router.get('/alertas', async (req, res) => {
  try {
    const em7dias = new Date(Date.now() + 7 * 86400000).toISOString();
    const { data: expirandoEmBreve } = await supabase.from('lojas')
      .select('id, nome, trial_expires_at, telefone')
      .eq('status', 'trial').lte('trial_expires_at', em7dias)
      .order('trial_expires_at', { ascending: true });

    const { data: bloqueadas } = await supabase.from('lojas')
      .select('id, nome, telefone, trial_expires_at')
      .eq('status', 'bloqueado').order('criado_em', { ascending: false }).limit(20);

    res.json({
      expirando_em_breve: expirandoEmBreve || [],
      bloqueadas: bloqueadas || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/pagamentos-recentes — últimos pagamentos aprovados em
// qualquer loja da plataforma (visão de receita entrando)
router.get('/pagamentos-recentes', async (req, res) => {
  try {
    const { data } = await supabase.from('pagamentos')
      .select('*, lojas(nome)').order('pago_em', { ascending: false }).limit(20);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
