-- Pagos a profesionales (Decles): «ya le pagué todo a Carmen». Lo que se le da a cada profesional de su parte
-- ($K) sale de la caja. `date` = el día que se le paga (normalmente lo de ese día).
CREATE TABLE IF NOT EXISTS provider_payouts (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS provider_payouts_org_date ON provider_payouts (organization_id, date);
