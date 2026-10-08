-- Precios y ventas (= Clavdia 0010_billing, sin el backfill de provider_prices).
--  · price_list_items: catálogo de precios; un `producto` apunta a su stock_item (vender descuenta stock).
--  · price_history:    cada cambio de importe.
--  · sales:            ventas; el movimiento de stock queda atado por stock_movements.sale_id.

CREATE TABLE IF NOT EXISTS price_list_items (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind            TEXT NOT NULL,                 -- consulta | tratamiento | producto
  name            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  provider_id     TEXT REFERENCES providers(id),
  stock_item_id   TEXT REFERENCES stock_items(id),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_unique
  ON price_list_items (organization_id, lower(name), COALESCE(provider_id, ''));
CREATE INDEX IF NOT EXISTS price_list_items_org ON price_list_items (organization_id, kind, active);

CREATE TABLE IF NOT EXISTS price_history (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  item_id         TEXT NOT NULL REFERENCES price_list_items(id),
  old_amount      INTEGER,
  new_amount      INTEGER NOT NULL,
  changed_by      TEXT NOT NULL,
  changed_by_name TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  changed_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_item ON price_history (item_id, changed_at);

CREATE TABLE IF NOT EXISTS sales (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  item_id         TEXT REFERENCES price_list_items(id),
  item_name       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price      INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  provider_id     TEXT REFERENCES providers(id),
  patient_id      TEXT REFERENCES patients(id),
  note            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'paid',  -- paid | voided
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT
);
CREATE INDEX IF NOT EXISTS sales_org_date ON sales (organization_id, created_at);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sale_id TEXT REFERENCES sales(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pricing_roles TEXT NOT NULL DEFAULT '[]';
