-- Núcleo multi-consultorio y login. Mismas tablas y columnas que Clavdia
-- (0001_init + 0002 + 0003 + 0006_org_whatsapp), recortadas a lo que usa el stock,
-- para que al integrar las filas pasen 1:1 a la base de Clavdia.
-- `patients` y `providers` quedan porque precios/ventas los referencian (vacíos o
-- mínimos acá; en Clavdia ya existen).

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  address       TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  hours         TEXT NOT NULL DEFAULT 'Lunes a viernes de 8 a 18 h',
  phone         TEXT NOT NULL DEFAULT '',
  whatsapp_from TEXT NOT NULL DEFAULT '',
  admin_ids     TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique ON organizations (slug);

CREATE TABLE IF NOT EXISTS patients (
  id                TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  dni               TEXT NOT NULL,
  date_of_birth     TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT NOT NULL,
  coverage          TEXT NOT NULL,
  allergies         TEXT NOT NULL DEFAULT '[]',
  active_conditions TEXT NOT NULL DEFAULT '[]',
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  dni        TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL,              -- medico | recepcion
  pin_hash   TEXT NOT NULL,              -- '' hasta que la persona elige su PIN ("Olvidé mi PIN")
  pin_salt   TEXT NOT NULL,
  patient_id TEXT REFERENCES patients(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique ON users (lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (lower(trim(email))) WHERE trim(email) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS users_dni_unique
  ON users (replace(replace(trim(dni), '.', ''), ' ', '')) WHERE trim(dni) <> '';

CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  specialty       TEXT NOT NULL,
  room_label      TEXT NOT NULL,
  default_fee     INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id         TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role            TEXT NOT NULL,        -- medico | recepcion
  provider_id     TEXT REFERENCES providers(id),
  can_admin       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS pin_reset_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  code_salt   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  sent_to     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS pin_reset_codes_user ON pin_reset_codes (user_id, created_at);
