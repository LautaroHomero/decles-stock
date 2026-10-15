-- Decles: la profesional que es admin del consultorio (la dueña) no cobra comisión: lo suyo va entero al
-- consultorio. Desde ahora se anota con parte 0; acá se ponen en 0 las partes ya anotadas de quienes hoy son
-- admin (ventas, deudas y cobros de deudas), para que no figuren como algo a pagarles.
UPDATE sales s SET commission_amount = 0, commission_pct = 0, commission_fixed = NULL
FROM memberships m JOIN organizations o ON o.id = m.organization_id
WHERE s.provider_id = m.provider_id AND s.organization_id = m.organization_id
  AND o.admin_ids::jsonb ? m.user_id AND s.commission_amount <> 0;

UPDATE debts d SET share = 0
FROM memberships m JOIN organizations o ON o.id = m.organization_id
WHERE d.provider_id = m.provider_id AND d.organization_id = m.organization_id
  AND o.admin_ids::jsonb ? m.user_id AND d.share <> 0;

UPDATE debt_payments p SET share = 0
FROM debts d, memberships m JOIN organizations o ON o.id = m.organization_id
WHERE p.debt_id = d.id AND d.provider_id = m.provider_id AND d.organization_id = m.organization_id
  AND o.admin_ids::jsonb ? m.user_id AND p.share <> 0;
