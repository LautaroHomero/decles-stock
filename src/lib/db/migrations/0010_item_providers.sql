-- Qué profesional hace cada tratamiento / vende cada producto (Decles). Muchos a muchos.
--  · Sin filas para un ítem = lo puede anotar cualquier profesional.
--  · En Clavdia `price_list_items.provider_id` es "precio propio de un profesional"; esto es distinto
--    (quién lo ofrece, mismo precio) y vive aparte para no mezclarlo.
CREATE TABLE IF NOT EXISTS price_item_providers (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  item_id         TEXT NOT NULL REFERENCES price_list_items(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  PRIMARY KEY (item_id, provider_id)
);
CREATE INDEX IF NOT EXISTS price_item_providers_org ON price_item_providers (organization_id);
