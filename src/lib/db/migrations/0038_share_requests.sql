-- Cambiar lo que se lleva la profesional en una atención (un descuento suyo, un error…).
--  · El admin lo cambia directo. Si lo cambia otra persona (secretaria, médica), queda pedido acá y la atención sigue
--    con lo de siempre hasta que el admin lo aprueba (o lo rechaza). Un pedido abierto por atención.
--  · `share` = lo pedido para toda la atención; `previous` = lo que había al pedirlo.
CREATE TABLE IF NOT EXISTS share_requests (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id),
  visit_id          TEXT NOT NULL,
  provider_id       TEXT,
  share             INTEGER NOT NULL CHECK (share >= 0),
  previous          INTEGER NOT NULL,
  reason            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by      TEXT NOT NULL,
  requested_by_name TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  resolved_by_name  TEXT,
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS share_requests_org ON share_requests (organization_id, status);
CREATE INDEX IF NOT EXISTS share_requests_visit ON share_requests (organization_id, visit_id);
