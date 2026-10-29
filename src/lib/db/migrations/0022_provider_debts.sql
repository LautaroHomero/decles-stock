-- Deudas del consultorio con sus profesionales (Decles): cuando no hay efectivo para pagarle su parte del día,
-- se anota «le quedamos debiendo» y se le paga otro día (todo o en partes). Los pagos de esas deudas son
-- `provider_payouts` con `provider_debt_id` (salen de la caja del día en que se pagan si son en efectivo).
-- Además, pagos a profesionales y egresos/ingresos extras pasan a tener medio: solo el efectivo toca la caja.
ALTER TABLE provider_payouts ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'efectivo';
ALTER TABLE provider_payouts ADD COLUMN IF NOT EXISTS provider_debt_id TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'efectivo';

CREATE TABLE IF NOT EXISTS provider_debts (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'open',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  paid_at         TEXT,
  voided_at       TEXT,
  voided_by       TEXT
);
CREATE INDEX IF NOT EXISTS provider_debts_org_status ON provider_debts (organization_id, status);
CREATE INDEX IF NOT EXISTS provider_debts_org_date ON provider_debts (organization_id, date);
CREATE INDEX IF NOT EXISTS provider_payouts_debt ON provider_payouts (provider_debt_id) WHERE provider_debt_id IS NOT NULL;
