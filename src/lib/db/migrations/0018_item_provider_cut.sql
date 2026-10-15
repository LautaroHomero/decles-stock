-- Parte de cada profesional en cada práctica / producto (Decles). Dos profesionales pueden hacer lo mismo
-- y llevarse distinto: un % propio o una plata fija por unidad. NULL en los dos = la regla de siempre
-- (el % del ítem si tiene, si no el de la profesional).
ALTER TABLE price_item_providers ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2)
  CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100));
ALTER TABLE price_item_providers ADD COLUMN IF NOT EXISTS commission_fixed INTEGER
  CHECK (commission_fixed IS NULL OR commission_fixed >= 0);

-- En la venta: la plata fija por unidad que se congeló (si se usó). Al corregir el importe no se
-- recalcula con el %: sigue siendo fija × cantidad.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_fixed INTEGER;
