-- Obras sociales: lo que se lleva la profesional depende de la práctica (ej. OSMECON: consulta $8.000, peeling otro).
-- Sin valor para una práctica, vale el general de la obra social (`insurers.provider_fee`). Una atención con varias
-- prácticas suma el valor de cada una.
CREATE TABLE IF NOT EXISTS insurer_practice_fees (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  insurer_id      TEXT NOT NULL REFERENCES insurers(id),
  item_id         TEXT NOT NULL,
  fee             INTEGER NOT NULL CHECK (fee >= 0),
  PRIMARY KEY (insurer_id, item_id)
);
