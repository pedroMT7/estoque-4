-- Leituras feitas sem internet são reenviadas pelo aparelho quando a conexão volta.
-- A chave gerada no aparelho garante que a mesma leitura nunca é registrada duas vezes
-- (ex.: o servidor gravou, mas a resposta não chegou ao celular e ele reenviou).
CREATE TABLE IF NOT EXISTS envios_aparelho (
  chave TEXT PRIMARY KEY,
  carregamento_id INT REFERENCES carregamentos(id),
  usuario_id INT REFERENCES usuarios(id),
  resposta JSONB NOT NULL,
  lido_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
