-- Campanita in-app. ÚNICA tabla que no existe en Clavdia: al integrar, esta misma
-- migración se agrega allá (próximo número libre). Ver src/lib/domain/notifications.ts.
--  · Una fila por destinatario (los médicos del consultorio).
--  · `dedupe_key` evita repetir el mismo aviso (ej. 'vence_pronto:<lotId>').

CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,          -- vence_pronto | vencido | stock_bajo
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  ref_id          TEXT,                   -- stock_items.id
  dedupe_key      TEXT NOT NULL,
  read_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications (user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, read_at, created_at);
