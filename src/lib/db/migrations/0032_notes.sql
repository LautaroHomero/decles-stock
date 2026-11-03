-- Notas (Decles): algo que se quiere dejar escrito de una paciente («le dio alergia la crema», «viene con el marido»).
-- Se anotan desde la Planilla (pegadas a una atención, `visit_id`) o sueltas desde Notas, y se buscan por paciente o texto.
CREATE TABLE IF NOT EXISTS notes (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_label   TEXT NOT NULL DEFAULT '',
  visit_id        TEXT,
  date            TEXT NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  updated_by_name TEXT
);
CREATE INDEX IF NOT EXISTS notes_org_date ON notes (organization_id, status, date);
CREATE INDEX IF NOT EXISTS notes_org_visit ON notes (organization_id, visit_id);

-- Las observaciones que ya se habían escrito en atenciones pasan a ser notas (una por atención).
INSERT INTO notes (id, organization_id, patient_label, visit_id, date, text, created_by, created_by_name, created_at)
SELECT 'not_' || substr(md5(s.visit_id), 1, 8), s.organization_id, COALESCE(MAX(s.patient_label), ''), s.visit_id,
       substr(MIN(s.created_at), 1, 10), MAX(s.observations), MAX(s.created_by), MAX(s.created_by_name), MIN(s.created_at)
FROM sales s
WHERE s.visit_id IS NOT NULL AND s.status = 'paid' AND COALESCE(s.observations, '') <> ''
GROUP BY s.organization_id, s.visit_id
ON CONFLICT (id) DO NOTHING;
