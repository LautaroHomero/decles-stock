-- Deudas (Decles): fecha para acordarse de cobrarla («paga el viernes», «recordar el 30/10»). AAAA-MM-DD; NULL = sin
-- recordatorio. Ese día (y después, mientras siga abierta) aparece en Anotar «Para cobrar hoy» y en la campanita del admin.
ALTER TABLE debts ADD COLUMN IF NOT EXISTS remind_on TEXT;
CREATE INDEX IF NOT EXISTS debts_org_remind ON debts (organization_id, remind_on) WHERE status = 'open' AND remind_on IS NOT NULL;
