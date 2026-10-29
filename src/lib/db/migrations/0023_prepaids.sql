-- Abonos (Decles): la paciente paga antes un tratamiento para congelar el precio y después se van haciendo las
-- sesiones, con cualquier profesional. Dos formas: N sesiones (`sessions`) o un saldo en plata (`sessions` NULL,
-- se descuenta `unit_price` por sesión). La plata entra a la caja el día que se paga: es un ingreso
-- (`expenses.direction 'ingreso'`, `income_id`). Cada sesión es una atención con `prepaid_uses`: a la caja no
-- entra nada y la profesional cobra su parte sobre el precio congelado ese día.
CREATE TABLE IF NOT EXISTS prepaids (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_label   TEXT NOT NULL,
  item_id         TEXT NOT NULL REFERENCES price_list_items(id),
  item_name       TEXT NOT NULL,
  unit_price      INTEGER NOT NULL CHECK (unit_price > 0),
  sessions        INTEGER CHECK (sessions IS NULL OR sessions > 0),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'efectivo',
  income_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS prepaids_org_status ON prepaids (organization_id, status);

CREATE TABLE IF NOT EXISTS prepaid_uses (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  prepaid_id      TEXT NOT NULL REFERENCES prepaids(id),
  visit_id        TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  date            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prepaid_uses_prepaid ON prepaid_uses (prepaid_id);
CREATE INDEX IF NOT EXISTS prepaid_uses_visit ON prepaid_uses (organization_id, visit_id);
