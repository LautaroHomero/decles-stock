-- Le pagan directo a la profesional (Decles): «botox a carla, carmen, 40000, le transfirieron a carmen, nos debe 36000».
--  · Medio 'profesional': la atención guarda su importe real, pero esa plata no entra a la caja; lo nuestro
--    (importe − su parte) se lo descuenta de lo que le debemos ese día y, si no alcanza, nos lo debe ella.
--  · provider_payouts.direction: 'pago' (le damos plata, sale de la caja) | 'cobro' (nos da plata, entra a la caja).
--  · provider_debts.direction: 'consultorio' (le quedamos debiendo) | 'profesional' (nos quedó debiendo).
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'mixto', 'giftcard', 'profesional'));
ALTER TABLE visit_payments DROP CONSTRAINT IF EXISTS visit_payments_method_check;
ALTER TABLE visit_payments ADD CONSTRAINT visit_payments_method_check
  CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'dolares', 'giftcard', 'profesional'));

ALTER TABLE provider_payouts ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'pago';
ALTER TABLE provider_debts ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'consultorio';
