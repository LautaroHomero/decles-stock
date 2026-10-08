-- "Primeros pasos" del admin: se oculta cuando lo cierra (los pasos se calculan de los datos).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN NOT NULL DEFAULT FALSE;
