-- Anotar sin trabas (Decles).
--  · stock_items.owed: unidades vendidas sin stock cargado. `available` = lotes vigentes − owed (puede ser
--    negativo). Al ingresar un lote se compensa solo (movimiento 'ajuste').
--  · Renglones "pendientes": algo que todavía no está en la lista de precios. Se guardan como sale con
--    item_id NULL y kind 'pendiente', sin importe; el admin los resuelve (vincula o crea el ítem) y ahí
--    se completan precio, comisión y stock.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS owed INTEGER NOT NULL DEFAULT 0 CHECK (owed >= 0);
CREATE INDEX IF NOT EXISTS sales_org_pending ON sales (organization_id, kind) WHERE kind = 'pendiente';
