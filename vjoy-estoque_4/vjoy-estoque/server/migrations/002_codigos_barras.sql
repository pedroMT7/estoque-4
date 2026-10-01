-- Códigos de barras adicionais por produto (etiquetas geradas por outro sistema)
CREATE TABLE produto_codigos (
  id          SERIAL PRIMARY KEY,
  produto_id  INT NOT NULL REFERENCES produtos(id),
  codigo      TEXT NOT NULL UNIQUE,
  origem      TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origem IN ('MANUAL','BIPAGEM','IMPORTACAO')),
  usuario_id  INT REFERENCES usuarios(id),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON produto_codigos(produto_id);
