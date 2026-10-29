-- Señas (Decles): la paciente deja una parte antes del turno («carla dejó 20000 de seña para botox, viene el 28/10»).
-- La seña entra a la caja el día que se deja (ingreso en `expenses`, `income_id`). El día que viene se descuenta:
-- paga solo el resto y no queda deuda; la profesional cobra su parte sobre el total (seña + resto).
-- Usada = su atención (`visit_id`) sigue vigente; si se anula la atención, la seña vuelve a estar disponible.
CREATE TABLE IF NOT EXISTS deposits (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_label   TEXT NOT NULL,
  item_id         TEXT REFERENCES price_list_items(id),
  item_name       TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'efectivo',
  due_on          TEXT,
  income_id       TEXT,
  visit_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS deposits_org_status ON deposits (organization_id, status);
CREATE INDEX IF NOT EXISTS deposits_visit ON deposits (organization_id, visit_id);
