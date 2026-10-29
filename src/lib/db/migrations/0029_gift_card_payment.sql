ALTER TABLE visit_payments DROP CONSTRAINT IF EXISTS visit_payments_method_check;
ALTER TABLE visit_payments ADD CONSTRAINT visit_payments_method_check
  CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'giftcard'));

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'mixto', 'giftcard'));