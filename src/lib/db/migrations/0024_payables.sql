-- Lo que debe el consultorio (Decles): a un proveedor, el alquiler, un servicio… («le debemos 300000 a la distribuidora»).
-- Recordatorio: `remind_mode` 'daily' (todos los días, al arrancar) o 'at' (`remind_at` = AAAA-MM-DDTHH:MM, hora de Buenos Aires).
-- Se paga todo o en partes: cada pago es un egreso (`expenses`, con su medio) del día en que se paga. Pagada o anulada, no avisa más.
CREATE TABLE IF NOT EXISTS payables (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  creditor        TEXT NOT NULL,
  concept         TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL CHECK (amount > 0),
  remind_mode     TEXT,
  remind_at       TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  paid_at         TEXT,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS payables_org_status ON payables (organization_id, status);

CREATE TABLE IF NOT EXISTS payable_payments (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  payable_id      TEXT NOT NULL REFERENCES payables(id),
  expense_id      TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payable_payments_payable ON payable_payments (payable_id);
CREATE INDEX IF NOT EXISTS payable_payments_expense ON payable_payments (expense_id);
