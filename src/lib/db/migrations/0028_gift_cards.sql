ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS gift_card BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS gift_cards (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('amount', 'treatment')),
  face_value      INTEGER NOT NULL CHECK (face_value > 0),
  treatment_item_id TEXT REFERENCES price_list_items(id),
  treatment_name  TEXT NOT NULL DEFAULT '',
  buyer           TEXT NOT NULL DEFAULT '',
  sale_id         TEXT NOT NULL REFERENCES sales(id),
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'voided')),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS gift_cards_org_status ON gift_cards (organization_id, status);

CREATE TABLE IF NOT EXISTS gift_card_uses (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  gift_card_id    TEXT NOT NULL REFERENCES gift_cards(id),
  visit_id        TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  created_at      TEXT NOT NULL,
  UNIQUE (organization_id, visit_id)
);
CREATE INDEX IF NOT EXISTS gift_card_uses_card ON gift_card_uses (gift_card_id);