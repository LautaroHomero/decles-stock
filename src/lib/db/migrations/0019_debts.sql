-- Deudas (Decles): alguien (casi siempre un paciente) le debe plata al consultorio. Ej.: un botox de $120.000,
-- pagó $80.000 y quedó debiendo $40.000. Se cobra después, de una vez o en partes, y lo cobrado entra a la caja
-- del día en que se paga.
--  · debts.share: la parte de la profesional en lo que se debe (se le paga a medida que se cobra).
--  · debt_payments.share: la parte de la profesional en ese cobro (cuenta para lo que se le debe ese día).
CREATE TABLE IF NOT EXISTS debts (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  debtor          TEXT NOT NULL,
  concept         TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL CHECK (amount > 0),
  provider_id     TEXT REFERENCES providers(id),
  share           INTEGER NOT NULL DEFAULT 0 CHECK (share >= 0),
  visit_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',   -- open | paid | voided
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  paid_at         TEXT,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS debts_org_status ON debts (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS debts_visit ON debts (organization_id, visit_id);

CREATE TABLE IF NOT EXISTS debt_payments (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  debt_id         TEXT NOT NULL REFERENCES debts(id),
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT,                            -- efectivo | transferencia | tarjeta (null = efectivo)
  share           INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | voided
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS debt_payments_org_date ON debt_payments (organization_id, date);
CREATE INDEX IF NOT EXISTS debt_payments_debt ON debt_payments (debt_id);
