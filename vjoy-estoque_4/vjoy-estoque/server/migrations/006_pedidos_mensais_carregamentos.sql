-- Pedidos mensais por cliente (ex.: 1.500 peças no mês) e carregamento de caminhão com romaneio em PDF
CREATE TABLE pedidos_mensais (
  id            SERIAL PRIMARY KEY,
  cliente_id    INT NOT NULL REFERENCES clientes(id),
  mes           DATE NOT NULL,                 -- primeiro dia do mês
  observacao    TEXT,
  criado_por    INT REFERENCES usuarios(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, mes)
);
CREATE TABLE pedido_mensal_itens (
  id                SERIAL PRIMARY KEY,
  pedido_mensal_id  INT NOT NULL REFERENCES pedidos_mensais(id) ON DELETE CASCADE,
  produto_id        INT NOT NULL REFERENCES produtos(id),
  quantidade        INT NOT NULL CHECK (quantidade > 0),
  UNIQUE (pedido_mensal_id, produto_id)
);
CREATE TABLE carregamentos (
  id                SERIAL PRIMARY KEY,
  cliente_id        INT NOT NULL REFERENCES clientes(id),
  pedido_mensal_id  INT REFERENCES pedidos_mensais(id),
  placa             TEXT,
  motorista         TEXT,
  observacao        TEXT,
  status            TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','FINALIZADO','CANCELADO')),
  usuario_id        INT NOT NULL REFERENCES usuarios(id),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em     TIMESTAMPTZ,
  finalizado_por    INT REFERENCES usuarios(id)
);
CREATE INDEX ON carregamentos(cliente_id, status);
CREATE TABLE carregamento_itens (
  id               SERIAL PRIMARY KEY,
  carregamento_id  INT NOT NULL REFERENCES carregamentos(id),
  produto_id       INT NOT NULL REFERENCES produtos(id),
  quantidade       INT NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  UNIQUE (carregamento_id, produto_id)
);
ALTER TABLE movimentacoes ADD COLUMN carregamento_id INT REFERENCES carregamentos(id);
ALTER TABLE leituras ADD COLUMN carregamento_id INT REFERENCES carregamentos(id);
ALTER TABLE leituras DROP CONSTRAINT IF EXISTS leituras_operacao_check;
ALTER TABLE leituras ADD CONSTRAINT leituras_operacao_check CHECK (operacao IN ('ENTRADA','SEPARACAO','CONFERENCIA','CONSULTA','CARREGAMENTO'));
