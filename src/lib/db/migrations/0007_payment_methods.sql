-- Precio con tarjeta y medio de pago de cada venta.
--  · price_list_items.amount sigue siendo el precio base = efectivo / transferencia (mismo valor).
--    card_amount = precio con tarjeta; NULL = igual al de efectivo.
--  · sales.payment_method: 'efectivo' (incluye transferencia) | 'tarjeta' | NULL (no se cargó).
--  · sales.cash_total / card_total: lo que vale la venta a cada precio, congelado al vender. Si no
--    se cargó el medio, los resúmenes muestran los dos. `total` = lo cobrado (sin medio: efectivo).
--  · La comisión se calcula siempre sobre cash_total (el recargo de tarjeta no cambia lo que cobra la médica).

ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS card_amount INTEGER CHECK (card_amount IS NULL OR card_amount >= 0);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('efectivo', 'tarjeta'));
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_total INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_total INTEGER;
UPDATE sales SET cash_total = total, card_total = total WHERE cash_total IS NULL;
