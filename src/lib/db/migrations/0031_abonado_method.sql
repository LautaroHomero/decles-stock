-- Medio «Abono» (Decles): la paciente es abonada y esa atención no trae plata hoy (ya la pagó antes), aunque no haya un
-- plan cargado en `prepaids`. La atención vale lo que salía y la profesional cobra su parte igual; no entra a la caja.
-- (Con gift card pasa lo mismo: medio 'giftcard' sin código = solo marca.)
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'mixto', 'giftcard', 'profesional', 'abonado'));
ALTER TABLE visit_payments DROP CONSTRAINT IF EXISTS visit_payments_method_check;
ALTER TABLE visit_payments ADD CONSTRAINT visit_payments_method_check
  CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'giftcard', 'profesional', 'abonado'));
