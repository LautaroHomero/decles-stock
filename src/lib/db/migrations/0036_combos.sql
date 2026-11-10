-- Combos / promos (Decles): varias prácticas y/o productos juntos a un precio especial («A + B» sale $3 en vez de $4).
--  · Se arman en Stock → Combos (solo admin). Las prácticas de un combo son de una misma profesional.
--  · Al anotar se aplican solos: cada renglón sigue siendo su venta (stock y parte de la profesional igual), con el precio
--    del combo repartido en proporción a la lista. `visit_combos` = qué combo se aplicó en cada atención (para mostrarlo).
--  · Dar de baja = `active` FALSE (las atenciones viejas lo siguen nombrando).
CREATE TABLE IF NOT EXISTS combos (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  card_amount     INTEGER CHECK (card_amount IS NULL OR card_amount >= 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS combos_org ON combos (organization_id, active);

CREATE TABLE IF NOT EXISTS combo_items (
  combo_id        TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES price_list_items(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (combo_id, item_id)
);

CREATE TABLE IF NOT EXISTS visit_combos (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  visit_id        TEXT NOT NULL,
  combo_id        TEXT NOT NULL REFERENCES combos(id),
  times           INTEGER NOT NULL DEFAULT 1 CHECK (times > 0),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (visit_id, combo_id)
);
CREATE INDEX IF NOT EXISTS visit_combos_org ON visit_combos (organization_id, visit_id);
