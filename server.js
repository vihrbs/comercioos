require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { verificarPlano } = require('./middleware/plano');
const { authMiddleware } = require('./middleware/auth');
const { verificarPermissao } = require('./middleware/permissao');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'ComercioOS', version: '1.0.0', timestamp: new Date() });
});

// Rate limit para rotas sensíveis de autenticação — evita brute-force de senha
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // 10 tentativas por IP nesse período
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Auth (sem verificação de plano — login precisa funcionar mesmo com plano vencido)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth', require('./routes/auth'));

// Assinatura (sem verificação de plano — precisa ser acessível mesmo bloqueado).
// O webhook (/api/assinatura/webhook) valida a assinatura do Mercado Pago
// internamente — não usa authMiddleware porque quem chama é o MP, não o usuário.
app.use('/api/assinatura', require('./routes/assinatura'));

// Rotas com um módulo só de front-end correspondente: checagem de permissão
// aplicada aqui mesmo, de forma simples.
app.use('/api/produtos', authMiddleware, verificarPlano, verificarPermissao('produtos'), require('./routes/produtos'));
app.use('/api/clientes', authMiddleware, verificarPlano, verificarPermissao('clientes'), require('./routes/clientes'));

// Rotas que atendem mais de uma tela do front (vendas.js = pdv + vendas;
// operacoes.js = funcionarios + comissoes + financeiro; relatorios.js =
// dashboard + relatorios + crediario). A checagem de permissão fica dentro
// de cada arquivo, rota a rota — só authMiddleware/verificarPlano aqui.
app.use('/api/vendas', authMiddleware, verificarPlano, require('./routes/vendas'));
app.use('/api/operacoes', authMiddleware, verificarPlano, require('./routes/operacoes'));
app.use('/api/relatorios', authMiddleware, verificarPlano, require('./routes/relatorios'));

// extras.js aplica authMiddleware e verificarPermissao internamente, rota a rota
app.use('/api', require('./routes/extras'));

// 404
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🛍️  ComercioOS Backend rodando na porta ${PORT}`);
});

module.exports = app;
