-- % de comisión propio de cada práctica / producto (Decles). NULL = se usa el % de la médica
-- (providers.commission_pct). Se congela en la venta igual que antes (sales.commission_*).
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2)
  CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100));
