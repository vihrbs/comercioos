require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { verificarPlano } = require('./middleware/plano');

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

// Auth (sem verificação de plano)
app.use('/api/auth', require('./routes/auth'));

// Assinatura (sem verificação de plano — precisa ser acessível mesmo bloqueado)
app.use('/api/assinatura', require('./routes/assinatura'));

// Rotas protegidas COM verificação de plano
const { authMiddleware } = require('./middleware/auth');
app.use('/api/produtos', authMiddleware, verificarPlano, require('./routes/produtos'));
app.use('/api/clientes', authMiddleware, verificarPlano, require('./routes/clientes'));
app.use('/api/vendas', authMiddleware, verificarPlano, require('./routes/vendas'));
app.use('/api/operacoes', authMiddleware, verificarPlano, require('./routes/operacoes'));
app.use('/api/relatorios', authMiddleware, verificarPlano, require('./routes/relatorios'));
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
