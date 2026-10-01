-- =====================================================================
-- VJOY ESTOQUE – controle físico pós-fabricação
-- Estoque = soma das movimentações (razão). Nada é editado ou apagado.
-- =====================================================================

CREATE TABLE usuarios (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  login         TEXT NOT NULL UNIQUE,
  senha_hash    TEXT NOT NULL,
  perfil        TEXT NOT NULL CHECK (perfil IN ('ADMIN','ESTOQUE','EXPEDICAO','CONFERENCIA','GESTAO')),
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ruas físicas do estoque
CREATE TABLE localizacoes (
  id            SERIAL PRIMARY KEY,
  codigo        TEXT NOT NULL UNIQUE,          -- ex.: R-05
  descricao     TEXT,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clientes (
  id              SERIAL PRIMARY KEY,
  codigo          TEXT NOT NULL UNIQUE,        -- ex.: CLI0001
  nome            TEXT NOT NULL,
  codigo_barras   TEXT NOT NULL UNIQUE,
  localizacao_id  INT REFERENCES localizacoes(id),
  status          TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','INATIVO')),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nomes de cliente como vêm no CSV (um cliente pode aparecer com mais de um nome)
CREATE TABLE cliente_aliases (
  id          SERIAL PRIMARY KEY,
  cliente_id  INT NOT NULL REFERENCES clientes(id),
  nome_origem TEXT NOT NULL UNIQUE,            -- nome normalizado (maiúsculo, espaços simples)
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE produtos (
  id                  SERIAL PRIMARY KEY,
  codigo              TEXT NOT NULL UNIQUE,    -- campo "Código" do CSV
  codigo_barras       TEXT NOT NULL UNIQUE,    -- por padrão = codigo (etiqueta da embalagem)
  codigo_laboratorio  TEXT,
  descricao           TEXT NOT NULL,
  unidade             TEXT,
  cor                 TEXT,
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE importacoes (
  id             SERIAL PRIMARY KEY,
  arquivo_nome   TEXT NOT NULL,
  arquivo_hash   TEXT NOT NULL,
  usuario_id     INT NOT NULL REFERENCES usuarios(id),
  status         TEXT NOT NULL CHECK (status IN ('PREVIA','CONFIRMADA','DESCARTADA')),
  resumo         JSONB NOT NULL DEFAULT '{}',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_em  TIMESTAMPTZ
);

-- Cada linha original do CSV e o que aconteceu com ela
CREATE TABLE importacao_linhas (
  id              SERIAL PRIMARY KEY,
  importacao_id   INT NOT NULL REFERENCES importacoes(id),
  linha           INT NOT NULL,
  numero_origem   TEXT,
  tipo            TEXT,
  resultado       TEXT NOT NULL,   -- NOVO | EXISTENTE | IGNORADA_SA | PENDENTE | DUPLICADA_ARQUIVO
  motivo          TEXT,
  alerta          TEXT,
  dados           JSONB NOT NULL
);
CREATE INDEX ON importacao_linhas(importacao_id);

-- Pedido = base do campo "Número" (043334/K/001 -> 043334)
CREATE TABLE pedidos (
  id             SERIAL PRIMARY KEY,
  numero         TEXT NOT NULL UNIQUE,
  emissao        DATE,
  cancelado      BOOLEAN NOT NULL DEFAULT FALSE,
  importacao_id  INT REFERENCES importacoes(id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Item = linha PA do CSV. numero_origem é a chave única (impede duplicar em reimportação)
CREATE TABLE pedido_itens (
  id                    SERIAL PRIMARY KEY,
  pedido_id             INT NOT NULL REFERENCES pedidos(id),
  numero_origem         TEXT NOT NULL UNIQUE,  -- 043334/K/001
  sub_pedido            TEXT NOT NULL,         -- K
  sequencia             TEXT NOT NULL,         -- 001
  produto_id            INT NOT NULL REFERENCES produtos(id),
  cliente_id            INT NOT NULL REFERENCES clientes(id),
  qtd_pedida            INT NOT NULL CHECK (qtd_pedida > 0),  -- "Qtde. Produzir"
  emissao               DATE,
  preco_venda           NUMERIC(14,5),
  possivel_duplicidade  BOOLEAN NOT NULL DEFAULT FALSE,
  importacao_id         INT REFERENCES importacoes(id),
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON pedido_itens(pedido_id);
CREATE INDEX ON pedido_itens(produto_id, cliente_id);

-- Sessões de separação
CREATE TABLE separacoes (
  id             SERIAL PRIMARY KEY,
  pedido_id      INT NOT NULL REFERENCES pedidos(id),
  usuario_id     INT NOT NULL REFERENCES usuarios(id),
  status         TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','NA_DOCA','CANCELADA')),
  iniciado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em  TIMESTAMPTZ,
  finalizado_por INT REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX separacao_aberta_unica ON separacoes(pedido_id) WHERE status = 'ABERTA';

CREATE TABLE conferencias (
  id              SERIAL PRIMARY KEY,
  pedido_id       INT NOT NULL REFERENCES pedidos(id),
  usuario_id      INT NOT NULL REFERENCES usuarios(id),
  status          TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','CONCLUIDA','CANCELADA')),
  parcial         BOOLEAN NOT NULL DEFAULT FALSE,
  autorizado_por  INT REFERENCES usuarios(id),
  iniciado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em   TIMESTAMPTZ,
  finalizado_por  INT REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX conferencia_aberta_unica ON conferencias(pedido_id) WHERE status = 'ABERTA';

CREATE TABLE conferencia_itens (
  id              SERIAL PRIMARY KEY,
  conferencia_id  INT NOT NULL REFERENCES conferencias(id),
  pedido_item_id  INT NOT NULL REFERENCES pedido_itens(id),
  esperado        INT NOT NULL,
  na_doca         INT NOT NULL,
  conferido       INT NOT NULL DEFAULT 0,
  UNIQUE (conferencia_id, pedido_item_id)
);

CREATE TABLE expedicoes (
  id           SERIAL PRIMARY KEY,
  pedido_id    INT NOT NULL REFERENCES pedidos(id),
  usuario_id   INT NOT NULL REFERENCES usuarios(id),
  quantidade   INT NOT NULL,
  observacao   TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE expedicao_conferencias (
  expedicao_id   INT NOT NULL REFERENCES expedicoes(id),
  conferencia_id INT NOT NULL REFERENCES conferencias(id) UNIQUE,
  PRIMARY KEY (expedicao_id, conferencia_id)
);

-- Cabeçalho de toda movimentação física
CREATE TABLE movimentacoes (
  id              SERIAL PRIMARY KEY,
  tipo            TEXT NOT NULL CHECK (tipo IN ('ENTRADA','SEPARACAO','ESTORNO_SEPARACAO','DOCA','CONFERENCIA','EXPEDICAO','AJUSTE','VINCULO','TRANSFERENCIA')),
  usuario_id      INT NOT NULL REFERENCES usuarios(id),
  autorizado_por  INT REFERENCES usuarios(id),
  pedido_id       INT REFERENCES pedidos(id),
  separacao_id    INT REFERENCES separacoes(id),
  conferencia_id  INT REFERENCES conferencias(id),
  expedicao_id    INT REFERENCES expedicoes(id),
  observacao      TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON movimentacoes(criado_em);
CREATE INDEX ON movimentacoes(tipo, criado_em);

-- Linhas da movimentação: cada linha soma/subtrai de um "saldo"
-- saldo = (produto, cliente, rua, pedido_item [NULL = livre], status)
CREATE TABLE movimentacao_itens (
  id               SERIAL PRIMARY KEY,
  movimentacao_id  INT NOT NULL REFERENCES movimentacoes(id),
  produto_id       INT NOT NULL REFERENCES produtos(id),
  cliente_id       INT NOT NULL REFERENCES clientes(id),
  localizacao_id   INT REFERENCES localizacoes(id),
  pedido_item_id   INT REFERENCES pedido_itens(id),
  status           TEXT NOT NULL CHECK (status IN ('ESTOQUE','SEPARADO','DOCA','CONFERIDO','EXPEDIDO')),
  delta            INT NOT NULL CHECK (delta <> 0),
  excedente        BOOLEAN NOT NULL DEFAULT FALSE    -- entrada acima da necessidade do pedido
);
CREATE INDEX ON movimentacao_itens(movimentacao_id);
CREATE INDEX ON movimentacao_itens(produto_id, cliente_id, status);
CREATE INDEX ON movimentacao_itens(pedido_item_id, status);

CREATE TABLE ajustes (
  id                 SERIAL PRIMARY KEY,
  movimentacao_id    INT NOT NULL REFERENCES movimentacoes(id),
  produto_id         INT NOT NULL REFERENCES produtos(id),
  cliente_id         INT NOT NULL REFERENCES clientes(id),
  pedido_item_id     INT REFERENCES pedido_itens(id),
  quantidade_anterior INT NOT NULL,
  ajuste             INT NOT NULL,
  quantidade_final   INT NOT NULL,
  motivo             TEXT NOT NULL,
  usuario_id         INT NOT NULL REFERENCES usuarios(id),
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Toda bipagem (certa ou errada) de todas as operações
CREATE TABLE leituras (
  id              SERIAL PRIMARY KEY,
  operacao        TEXT NOT NULL CHECK (operacao IN ('ENTRADA','SEPARACAO','CONFERENCIA','CONSULTA')),
  codigo_lido     TEXT NOT NULL,
  resultado       TEXT NOT NULL,    -- OK, PRODUTO_INCORRETO, QUANTIDADE_EXCEDIDA, ...
  nivel           TEXT NOT NULL CHECK (nivel IN ('SUCESSO','ALERTA','ERRO')),
  mensagem        TEXT,
  usuario_id      INT NOT NULL REFERENCES usuarios(id),
  autorizado_por  INT REFERENCES usuarios(id),
  produto_id      INT REFERENCES produtos(id),
  cliente_id      INT REFERENCES clientes(id),
  pedido_id       INT REFERENCES pedidos(id),
  separacao_id    INT REFERENCES separacoes(id),
  conferencia_id  INT REFERENCES conferencias(id),
  movimentacao_id INT REFERENCES movimentacoes(id),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON leituras(criado_em);
CREATE INDEX ON leituras(nivel, criado_em);

-- Auditoria geral (login, cadastros, importação, autorizações)
CREATE TABLE logs (
  id          SERIAL PRIMARY KEY,
  usuario_id  INT REFERENCES usuarios(id),
  acao        TEXT NOT NULL,
  entidade    TEXT,
  entidade_id INT,
  detalhes    JSONB,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Razão protegido: impede UPDATE/DELETE em movimentações e leituras
CREATE FUNCTION bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registros de % não podem ser alterados ou apagados', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER mov_imutavel BEFORE UPDATE OR DELETE ON movimentacoes FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao();
CREATE TRIGGER movi_imutavel BEFORE UPDATE OR DELETE ON movimentacao_itens FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao();
CREATE TRIGGER leit_imutavel BEFORE UPDATE OR DELETE ON leituras FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao();
CREATE TRIGGER aj_imutavel BEFORE UPDATE OR DELETE ON ajustes FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao();

-- Saldos atuais por "bucket"
CREATE VIEW v_saldos AS
SELECT produto_id, cliente_id, localizacao_id, pedido_item_id, status, SUM(delta)::int AS qtd
FROM movimentacao_itens
GROUP BY produto_id, cliente_id, localizacao_id, pedido_item_id, status
HAVING SUM(delta) <> 0;

-- Resumo por item de pedido: necessidade x entrou x saiu x saldo físico
CREATE VIEW v_item_resumo AS
SELECT pi.id AS pedido_item_id, pi.pedido_id, pi.produto_id, pi.cliente_id, pi.qtd_pedida,
  COALESCE(SUM(CASE WHEN m.tipo IN ('ENTRADA') AND mi.delta > 0 THEN mi.delta END),0)::int AS entrou,
  COALESCE(SUM(CASE WHEN m.tipo = 'VINCULO' THEN (CASE WHEN mi.status='ESTOQUE' THEN mi.delta END) END),0)::int AS vinculado,
  COALESCE(SUM(CASE WHEN m.tipo = 'AJUSTE' THEN mi.delta END),0)::int AS ajustado,
  COALESCE(SUM(CASE WHEN mi.status = 'ESTOQUE' THEN mi.delta END),0)::int AS em_estoque,
  COALESCE(SUM(CASE WHEN mi.status = 'SEPARADO' THEN mi.delta END),0)::int AS separado,
  COALESCE(SUM(CASE WHEN mi.status = 'DOCA' THEN mi.delta END),0)::int AS na_doca,
  COALESCE(SUM(CASE WHEN mi.status = 'CONFERIDO' THEN mi.delta END),0)::int AS conferido,
  COALESCE(SUM(CASE WHEN mi.status = 'EXPEDIDO' THEN mi.delta END),0)::int AS expedido
FROM pedido_itens pi
LEFT JOIN movimentacao_itens mi ON mi.pedido_item_id = pi.id
LEFT JOIN movimentacoes m ON m.id = mi.movimentacao_id
GROUP BY pi.id;
