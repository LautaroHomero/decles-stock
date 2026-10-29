-- Obras sociales y prepagas (Decles): la paciente se atiende «por OSMECON». A la caja no entra nada y la
-- profesional que la atendió se lleva un monto fijo por atención (`provider_fee`), que paga el consultorio.
-- `insurer_visits`: qué atención fue por cuál (y cuánto le tocó a la profesional, congelado).
CREATE TABLE IF NOT EXISTS insurers (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  provider_fee    INTEGER NOT NULL DEFAULT 0 CHECK (provider_fee >= 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS insurers_org_name ON insurers (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS insurer_visits (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  visit_id        TEXT NOT NULL,
  insurer_id      TEXT NOT NULL REFERENCES insurers(id),
  fee             INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (organization_id, visit_id)
);

-- OSMECON a $8.000 por atención en cada consultorio (se cambia en Equipo).
INSERT INTO insurers (id, organization_id, name, provider_fee, created_at)
SELECT 'ins_' || substr(md5(o.id || 'osmecon'), 1, 8), o.id, 'OSMECON', 8000, to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD"T"HH24:MI:SS')
FROM organizations o
ON CONFLICT DO NOTHING;
