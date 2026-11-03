-- Dólares (Decles): lo que entra o sale en dólares se guarda en dólares (`usd`) y así se muestra y se cuenta, aparte de
-- los pesos. `amount` sigue en pesos a la cotización de ese momento (`rate`) solo para las cuentas internas: lo que
-- descuenta una seña, el saldo de un abono, lo que falta de una deuda y la parte de la profesional (que se paga en pesos).
-- Medio 'dolares' en ingresos/egresos extras, cobros de deudas, señas y abonos.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS usd NUMERIC(12,2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rate NUMERIC(12,2);
ALTER TABLE debt_payments ADD COLUMN IF NOT EXISTS usd NUMERIC(12,2);
ALTER TABLE debt_payments ADD COLUMN IF NOT EXISTS rate NUMERIC(12,2);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS usd NUMERIC(12,2);
ALTER TABLE prepaids ADD COLUMN IF NOT EXISTS usd NUMERIC(12,2);
