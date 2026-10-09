-- Cambio al iniciar el día (Decles): al entrar, a la secretaria se le pregunta cuánto cambio hay en la caja.
--  · day_cash.opening: lo que había al abrir. `amount` (contado al cambio) pasa a ser opcional.
ALTER TABLE day_cash ADD COLUMN IF NOT EXISTS opening INTEGER CHECK (opening IS NULL OR opening >= 0);
ALTER TABLE day_cash ALTER COLUMN amount DROP NOT NULL;
