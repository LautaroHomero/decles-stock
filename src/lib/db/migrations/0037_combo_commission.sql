-- Combos: lo que se lleva la profesional por el combo, si es distinto de lo de cada práctica.
--  · `commission_pct`: % sobre lo cobrado por el combo; `commission_fixed`: monto fijo por combo.
--  · Los dos NULL = como siempre (lo de cada práctica / su %). La dueña no cobra igual.
ALTER TABLE combos ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100));
ALTER TABLE combos ADD COLUMN IF NOT EXISTS commission_fixed INTEGER CHECK (commission_fixed IS NULL OR commission_fixed >= 0);
