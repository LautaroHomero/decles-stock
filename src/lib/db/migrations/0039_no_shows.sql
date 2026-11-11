-- Ausentes (Decles): la paciente no vino (y no avisó a tiempo). Se anota como una atención marcada acá.
--  · Ese día no entra plata salvo lo que se le pida a la paciente («abono» por la hora); la seña, si había, ya entró.
--  · La profesional cobra lo que se cobró por esa hora (la seña + lo pedido); si es menos, se cambia su parte.
CREATE TABLE IF NOT EXISTS no_shows (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  visit_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (visit_id)
);
CREATE INDEX IF NOT EXISTS no_shows_org ON no_shows (organization_id);
