-- Egresos de plata (Decles): lo que sale de la caja (luz, insumos, retiros…). Tabla nueva, no toca Clavdia.
--  · status: active | voided. Editar reescribe el mismo renglón y deja quién y cuándo.
CREATE TABLE IF NOT EXISTS expenses (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  concept         TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  updated_by_name TEXT,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS expenses_org_date ON expenses (organization_id, created_at);
