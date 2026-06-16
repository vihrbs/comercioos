const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!['admin', 'gerente'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
};

module.exports = { authMiddleware, requireAdmin };
