-- Planilla diaria (Decles): la vista que copia la planilla en papel de la secretaria.
--  · providers.area: sección de la planilla (medicos | kinesiologia | auxiliares | externos).
--  · sales.payment_method suma 'transferencia' (antes iba con efectivo; precio = efectivo).
--  · sales.price_manual / commission_manual: el importe ("Abona") o la parte de la profesional ($K)
--    se escribieron a mano en la planilla (no salen de la lista de precios ni del %).
--  · sales.observations: la columna «Observaciones» de la planilla (productos vendidos y notas; `note` queda
--    para «Editado por…»).
--  · expenses.direction: 'egreso' | 'ingreso' (ingresos extras: cambio, varios…).
--  · day_cash: "Dinero en caja al momento del cambio", uno por día.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT 'medicos'
  CHECK (area IN ('medicos', 'kinesiologia', 'auxiliares', 'externos'));

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('efectivo', 'transferencia', 'tarjeta'));
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS observations TEXT NOT NULL DEFAULT '';

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'egreso' CHECK (direction IN ('egreso', 'ingreso'));

CREATE TABLE IF NOT EXISTS day_cash (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  updated_by_name TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (organization_id, date)
);
