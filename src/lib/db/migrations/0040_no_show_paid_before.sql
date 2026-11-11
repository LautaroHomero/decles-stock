-- Ausentes: lo que la paciente ya había pagado otro día por esa hora (una seña vieja que no está cargada como seña).
-- No entra a la caja de hoy; la profesional lo cobra igual (su parte = lo de hoy + la seña cargada + esto).
ALTER TABLE no_shows ADD COLUMN IF NOT EXISTS paid_before INTEGER NOT NULL DEFAULT 0 CHECK (paid_before >= 0);
