-- Pagos en varios medios y en dólares (Decles).
--  · visit_payments: cómo se pagó una anotación cuando no es un solo medio en pesos («mitad efectivo, mitad
--    tarjeta», «100 dólares»). `amount` siempre en pesos; en dólares también `usd` y la cotización usada (`rate`).
--  · sales.payment_method suma 'dolares' (todo en dólares) y 'mixto' (varios medios: el detalle en visit_payments).
--  · day_cash.usd_rate: cotización del dólar que se usó ese día (blue, promedio compra/venta, o la que se escribió).
CREATE TABLE IF NOT EXISTS visit_payments (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  visit_id        TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares')),
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  usd             NUMERIC(12,2),
  rate            NUMERIC(12,2),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visit_payments_org_visit ON visit_payments (organization_id, visit_id);

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'mixto'));

ALTER TABLE day_cash ADD COLUMN IF NOT EXISTS usd_rate NUMERIC(12,2);
