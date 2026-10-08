-- Cuentas con usuario + contraseña y comisiones de venta por médica.
-- Todo aditivo sobre las tablas de Clavdia (los PIN quedan, vacíos, por compatibilidad).
--
--  · users.username / password_*: login. La contraseña la elige la persona; el admin solo
--    da una temporal (must_change_password) al dar de alta o resetear.
--  · users.active: baja lógica (no se borra nadie: sus ventas siguen con su nombre).
--  · users.session_version: se incrementa al dar de baja o resetear la contraseña y
--    revoca al instante las sesiones abiertas (la cookie lleva la versión).
--  · users.failed_logins / locked_until: bloqueo de 15 min tras 5 intentos fallidos.
--  · providers.commission_pct: % de comisión de cada médica (lo fija el admin).
--  · sales.commission_*: % y monto congelados al vender (cambiar el % no reescribe el pasado).

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username)) WHERE username <> '';

ALTER TABLE providers ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (commission_pct >= 0 AND commission_pct <= 100);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_amount INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sales_org_provider ON sales (organization_id, provider_id, created_at);
