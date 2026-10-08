-- Apodos de cada persona ("pili, pilu"), separados por coma. Los usa la hoja de ventas
-- para reconocer quién vendió cuando el apodo no se deduce del nombre (Pilar → pili, Dolores → lola).
ALTER TABLE users ADD COLUMN IF NOT EXISTS aliases TEXT NOT NULL DEFAULT '';
