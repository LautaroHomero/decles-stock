-- Notas con recordatorio (Decles): «acordarme de cargar la seña de Carla el viernes». El día elegido avisa en la
-- campanita (a quien la escribió y a los admins) y queda arriba en Notas hasta que se toca «Hecho».
ALTER TABLE notes ADD COLUMN IF NOT EXISTS remind_on TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS remind_done_at TEXT;
CREATE INDEX IF NOT EXISTS notes_org_remind ON notes (organization_id, remind_on) WHERE remind_on IS NOT NULL AND remind_done_at IS NULL AND status = 'active';
