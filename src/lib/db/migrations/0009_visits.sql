-- Anotar pacientes y prácticas (Decles). Todo aditivo sobre `sales` de Clavdia.
--  · Prácticas = price_list_items kind 'tratamiento' (sin stock), con precio efectivo/tarjeta como los productos.
--    Generan comisión para la médica igual que un producto.
--  · sales.patient_label: el paciente es solo un nombre escrito (no hay ficha). En Clavdia, patient_id.
--  · sales.visit_id: los renglones que se anotaron juntos (una atención o una venta de varios productos).

ALTER TABLE sales ADD COLUMN IF NOT EXISTS patient_label TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS visit_id TEXT;
CREATE INDEX IF NOT EXISTS sales_org_visit ON sales (organization_id, visit_id);
