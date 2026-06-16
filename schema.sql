-- ComercioOS - Schema Supabase
-- Execute este SQL no Supabase SQL Editor

-- ========================
-- LOJAS
-- ========================
CREATE TABLE IF NOT EXISTS lojas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  tipo TEXT DEFAULT 'moda', -- moda, calcados, acessorios, multiuso
  cnpj TEXT,
  telefone TEXT,
  email TEXT,
  endereco TEXT,
  cidade TEXT,
  estado TEXT,
  cep TEXT,
  logo_url TEXT,
  cor_primaria TEXT DEFAULT '#6366f1',
  plano TEXT DEFAULT 'basico', -- basico, pro, enterprise
  ativa BOOLEAN DEFAULT true,
  configuracoes JSONB DEFAULT '{}',
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- USUARIOS
-- ========================
CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  perfil TEXT DEFAULT 'vendedor', -- admin, gerente, vendedor, caixa
  ativo BOOLEAN DEFAULT true,
  ultimo_acesso TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- CATEGORIAS
-- ========================
CREATE TABLE IF NOT EXISTS categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  ativa BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- PRODUTOS
-- ========================
CREATE TABLE IF NOT EXISTS produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  categoria_id UUID REFERENCES categorias(id),
  codigo TEXT,
  nome TEXT NOT NULL,
  descricao TEXT,
  preco_custo DECIMAL(10,2) DEFAULT 0,
  preco_venda DECIMAL(10,2) NOT NULL,
  preco_promocional DECIMAL(10,2),
  em_promocao BOOLEAN DEFAULT false,
  imagem_url TEXT,
  marca TEXT,
  genero TEXT DEFAULT 'unissex', -- masculino, feminino, infantil, unissex
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- VARIAÇÕES (tamanho, cor)
-- ========================
CREATE TABLE IF NOT EXISTS variacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id UUID REFERENCES produtos(id) ON DELETE CASCADE,
  tamanho TEXT, -- PP, P, M, G, GG, XGG, 34, 36...
  cor TEXT,
  estoque INTEGER DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 5,
  codigo_barras TEXT,
  ativo BOOLEAN DEFAULT true
);

-- ========================
-- CLIENTES
-- ========================
CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT,
  telefone TEXT,
  cpf TEXT,
  data_nascimento DATE,
  genero TEXT,
  endereco TEXT,
  cidade TEXT,
  estado TEXT,
  cep TEXT,
  pontos INTEGER DEFAULT 0,
  total_compras DECIMAL(10,2) DEFAULT 0,
  num_compras INTEGER DEFAULT 0,
  ultima_compra TIMESTAMPTZ,
  observacoes TEXT,
  tags TEXT[],
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- FUNCIONARIOS
-- ========================
CREATE TABLE IF NOT EXISTS funcionarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  usuario_id UUID REFERENCES usuarios(id),
  nome TEXT NOT NULL,
  cargo TEXT DEFAULT 'Vendedor',
  email TEXT,
  telefone TEXT,
  cpf TEXT,
  salario_base DECIMAL(10,2) DEFAULT 0,
  comissao_pct DECIMAL(5,2) DEFAULT 0, -- percentual de comissão
  meta_mensal DECIMAL(10,2) DEFAULT 0,
  data_admissao DATE,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- VENDAS
-- ========================
CREATE TABLE IF NOT EXISTS vendas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES clientes(id),
  funcionario_id UUID REFERENCES funcionarios(id),
  numero TEXT NOT NULL, -- ex: V-0001
  status TEXT DEFAULT 'finalizada', -- aberta, finalizada, cancelada, devolvida
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  desconto_pct DECIMAL(5,2) DEFAULT 0,
  desconto_valor DECIMAL(10,2) DEFAULT 0,
  acrescimo DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  forma_pagamento TEXT DEFAULT 'dinheiro', -- dinheiro, pix, debito, credito, crediario
  parcelas INTEGER DEFAULT 1,
  status_pagamento TEXT DEFAULT 'pago', -- pago, pendente, parcial
  troco DECIMAL(10,2) DEFAULT 0,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- ITENS DA VENDA
-- ========================
CREATE TABLE IF NOT EXISTS venda_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id UUID REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id UUID REFERENCES produtos(id),
  variacao_id UUID REFERENCES variacoes(id),
  nome_produto TEXT NOT NULL,
  tamanho TEXT,
  cor TEXT,
  quantidade INTEGER NOT NULL DEFAULT 1,
  preco_unitario DECIMAL(10,2) NOT NULL,
  desconto DECIMAL(10,2) DEFAULT 0,
  subtotal DECIMAL(10,2) NOT NULL
);

-- ========================
-- PEDIDOS / COMANDAS
-- ========================
CREATE TABLE IF NOT EXISTS pedidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES clientes(id),
  funcionario_id UUID REFERENCES funcionarios(id),
  numero TEXT NOT NULL,
  status TEXT DEFAULT 'aberto', -- aberto, em_separacao, pronto, entregue, cancelado
  tipo TEXT DEFAULT 'balcao', -- balcao, reserva, online
  total DECIMAL(10,2) DEFAULT 0,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- CAIXA (abertura/fechamento)
-- ========================
CREATE TABLE IF NOT EXISTS caixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  funcionario_id UUID REFERENCES funcionarios(id),
  saldo_inicial DECIMAL(10,2) DEFAULT 0,
  saldo_final DECIMAL(10,2),
  total_vendas DECIMAL(10,2) DEFAULT 0,
  total_dinheiro DECIMAL(10,2) DEFAULT 0,
  total_pix DECIMAL(10,2) DEFAULT 0,
  total_debito DECIMAL(10,2) DEFAULT 0,
  total_credito DECIMAL(10,2) DEFAULT 0,
  total_crediario DECIMAL(10,2) DEFAULT 0,
  status TEXT DEFAULT 'aberto', -- aberto, fechado
  aberto_em TIMESTAMPTZ DEFAULT NOW(),
  fechado_em TIMESTAMPTZ,
  observacoes TEXT
);

-- ========================
-- MOVIMENTAÇÕES FINANCEIRAS
-- ========================
CREATE TABLE IF NOT EXISTS movimentacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  caixa_id UUID REFERENCES caixas(id),
  tipo TEXT NOT NULL, -- entrada, saida
  categoria TEXT, -- venda, sangria, suprimento, despesa, etc
  descricao TEXT NOT NULL,
  valor DECIMAL(10,2) NOT NULL,
  forma_pagamento TEXT DEFAULT 'dinheiro',
  referencia_id UUID, -- id da venda, se houver
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- CREDIÁRIO
-- ========================
CREATE TABLE IF NOT EXISTS crediario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id UUID REFERENCES lojas(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES clientes(id),
  venda_id UUID REFERENCES vendas(id),
  total DECIMAL(10,2) NOT NULL,
  pago DECIMAL(10,2) DEFAULT 0,
  saldo DECIMAL(10,2) NOT NULL,
  num_parcelas INTEGER DEFAULT 1,
  parcelas_pagas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ativo', -- ativo, quitado, inadimplente
  vencimento DATE,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ========================
-- INDEXES
-- ========================
CREATE INDEX IF NOT EXISTS idx_produtos_loja ON produtos(loja_id);
CREATE INDEX IF NOT EXISTS idx_variacoes_produto ON variacoes(produto_id);
CREATE INDEX IF NOT EXISTS idx_vendas_loja ON vendas(loja_id);
CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_clientes_loja ON clientes(loja_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_loja ON movimentacoes(loja_id);

-- ========================
-- RLS (Row Level Security)
-- ========================
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendas ENABLE ROW LEVEL SECURITY;

-- Políticas abertas para service_key (backend controla acesso)
CREATE POLICY "service_full_access" ON lojas FOR ALL USING (true);
CREATE POLICY "service_full_access" ON usuarios FOR ALL USING (true);
CREATE POLICY "service_full_access" ON produtos FOR ALL USING (true);
CREATE POLICY "service_full_access" ON variacoes FOR ALL USING (true);
CREATE POLICY "service_full_access" ON categorias FOR ALL USING (true);
CREATE POLICY "service_full_access" ON clientes FOR ALL USING (true);
CREATE POLICY "service_full_access" ON funcionarios FOR ALL USING (true);
CREATE POLICY "service_full_access" ON vendas FOR ALL USING (true);
CREATE POLICY "service_full_access" ON venda_itens FOR ALL USING (true);
CREATE POLICY "service_full_access" ON pedidos FOR ALL USING (true);
CREATE POLICY "service_full_access" ON caixas FOR ALL USING (true);
CREATE POLICY "service_full_access" ON movimentacoes FOR ALL USING (true);
CREATE POLICY "service_full_access" ON crediario FOR ALL USING (true);
