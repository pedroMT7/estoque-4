-- Saída direta por bipagem: a "conferência" pode ser feita direto do estoque (sem separação/doca)
ALTER TABLE conferencias ADD COLUMN modo TEXT NOT NULL DEFAULT 'DOCA' CHECK (modo IN ('DOCA','DIRETA'));
