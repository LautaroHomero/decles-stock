@AGENTS.md

# Klavdia · Stock (Decles) — guía para trabajar en este repo

Recorte de **Clavdia** para el stock del consultorio Decles. Se va a integrar a Clavdia:
**no cambies nombres de tablas/columnas ni la forma de las funciones copiadas** de allá
(`stock.ts`, `billing.ts`, `stock-repo.ts`, `billing-repo.ts`, `repo.ts`, auth). Si algo
nuevo hace falta, agregalo como parámetro opcional o archivo nuevo y anotalo en
"Integración con Clavdia" del README.

- Autorización siempre en el servidor (`src/lib/domain/*`), scoping por `organization_id`.
- Vender (`recordSale`) no requiere permiso de stock; cargar/corregir inventario sí (solo admin).
- Cuentas: usuario + contraseña (`domain/accounts.ts`). Toda baja o reset sube `users.session_version`
  (revoca sesiones). Con `must_change_password` la API solo permite `/api/auth/password` y `/api/auth/email`.
- Recuperar contraseña: código por mail (`requestPasswordReset`/`confirmPasswordReset`, `src/lib/mail.ts`).
  La respuesta a "mandame el código" nunca revela si la cuenta existe.
- Venta de producto o práctica exige médica (`providerId`); la comisión se congela en `sales.commission_*`.
  Qué se lleva: su parte en ese ítem (`price_item_providers`, % o plata fija) → % del ítem → % de la profesional (`commissionFor`).
  La profesional que es **admin** del consultorio (la dueña) no cobra comisión: parte 0 siempre (`domain/owners.ts`), sin
  pagos a profesional ni parte en deudas; en Equipo/Cierre/Anotar figura «admin · sin comisión». Migración 0020 puso en 0 lo ya anotado.
- Anotar = `recordVisit` (`domain/visits.ts`): renglones con el mismo `visit_id`, todo o nada. Paciente = texto libre, **obligatorio si hay una práctica** (pantalla y servidor).
  Lo no cargado = venta `kind 'pendiente'` (resuelve el admin, `domain/pending.ts`); sin stock = `stock_items.owed`.
  Al crear/editar un ítem de la lista, los pendientes con el mismo nombre (sin tildes ni mayúsculas) se resuelven solos
  (`resolvePendingByName`); al resolver con importe escrito, la parte de la profesional se recalcula con la del ítem (salvo manual).
- Diseño monocromo (negro y blanco, Inter): tokens `--cl-*` en `globals.css`; acción principal `bg-accent text-on-accent`.
  Color solo con significado y sutil: `in` (verde, plata que entra), `owe` (deuda), `warn` (falta un dato); hoy lo usa el cobro de deuda en Anotar.
- Pestaña **Planilla** (antes «Ventas», `ventas-view.tsx`). Día = `planilla-view.tsx` (filas por área) + `planilla-movimientos.tsx`
  (otros ingresos, egresos y pagos a profesionales, quedaron debiendo, resumen entró/salió/queda y medios).
- Planilla: `planilla-view.tsx` = Planilla → Día (filas por área); `cierre-sheet.tsx` = Cierre (números del día, por profesional, ingresos/egresos extras, caja, medios de pago). Áreas = `providers.area`; fila = visita con
  `amount`/`commission` manuales (`applyManualAmounts`), «Atención» sin práctica (`generic`). Fila = paciente · qué pagó (práctica/producto) · médica · pagó $ · medio (+ $K fuera de Médicos).
  Ingresos extras = `expenses.direction 'ingreso'`; caja = `day_cash` (`opening` = cambio al iniciar, se le pregunta a la secretaria al entrar — `opening-cash.tsx`; `amount` = contado al cambio). Pago: efectivo | transferencia | tarjeta.
- Plata al anotar (`money-note.ts`): la secretaria dice cuánto ingresó («45000», «pagó 40 mil»); el reparto lo hace el
  sistema (% de la profesional) salvo que lo aclare («le corresponden 9000»). «le transfirieron a carmen» / «abono» = ingresó $0.
  Se guarda con `amount`/`commission` manuales; resolver un pendiente no pisa lo escrito.
- Pagos a profesionales (`domain/payouts.ts`, tabla `provider_payouts`, `method` efectivo|transferencia): «le pagué todo a Carmen»,
  «le transferí 18000 a Carmen» (Anotar, `parsePayout`) o «Pagar todo» / «por transf.» en Cierre. Debe = su parte del día ($K) − pagado − quedó debiendo.
  Si no hay efectivo: «le quedamos debiendo 50000 a Carmen» (`parseProviderDebt`) o «Queda debiendo» en Cierre → `provider_debts` (migración 0022).
  Se paga otro día («le pagué la deuda a Carmen», Cierre → «Le debemos a profesionales»): `provider_payouts` con `provider_debt_id`,
  cuenta en la caja del día del pago, no en la cuenta de su día. Cierre = entró / salió / movimientos.
- Pago directo a la profesional (migración 0030): medio `profesional` (sale o parte en `visit_payments`). «botox a carla, le transfirieron
  a carmen, nos debe 36000» (`money-note.ts`: `toProvider`, `owesUs` → su parte = lo cobrado − lo que nos debe; si no, su %). La atención
  guarda su importe real pero no entra a la caja ni a «Entró» (`outsideOf` en `shared.tsx`). Cuenta del día por profesional (`balances`):
  su parte − cobró ella directo − pagado + cobrado − quedamos debiendo + nos quedó debiendo; `owed` (le debemos) / `owesUs` (nos debe), con
  `lines` por atención. Cobro = `provider_payouts.direction 'cobro'` (entra a la caja); «Nos queda debiendo» = `provider_debts.direction
  'profesional'` (lista «Nos deben los profesionales», se cobra con `/api/provider-debts/pay`). Cierre → «Cuentas con profesionales» (`cuentas-profesionales.tsx`).
- Caja: «Debería haber» = cambio + efectivo cobrado + ingresos extras en efectivo − egresos en efectivo − pagos a profesionales en efectivo.
  Egresos/ingresos extras tienen `expenses.method` (efectivo|transferencia|tarjeta; «pagué 5000 de luz por transferencia»).
- Deudas (`domain/debts.ts`, tablas `debts` + `debt_payments`): alguien le debe al consultorio. «botox a carla, gabi, pagó 80000,
  debe 40000» (`VisitInput.debt`) o suelta «carla debe 40000»; se cobra «carla pagó la deuda» (`parseDebtPayment`) o «Cobrar» en
  Cierre. Cada cobro entra a la caja del día en que se paga y suma la parte de la profesional (`share`) a lo que se le debe ese día.
  Aviso `deuda` para los admins mientras esté abierta (se va al saldarse).
  Recordatorio: `debts.remind_on` (migración 0021). Del texto («paga el viernes», «recordar el 30/10», «a fin de mes» →
  `reminder-note.ts`, solo si hay deuda o verbo «recordar/avisar/cobrar») o con `ReminderPicker` (`debt-reminder.tsx`);
  se cambia en Cierre → Deudas (`PATCH /api/debts/[id]`). Llegada la fecha: aviso `deuda_cobrar` a los admins y
  «Para cobrar hoy» en Anotar (`/api/debts/reminders`, «En una semana» lo pospone).
  Partes sin importe: «la mitad en efectivo y la mitad con tarjeta», «debe la otra mitad», «30% tarjeta» → `MoneyNote.fractions`
  (`fractionsToPesos` sobre el precio o lo que dijo que pagó). La vista manual y «Editar detalles» también tienen varios medios y «Queda debiendo».
- Abonos (`domain/prepaids.ts`, tablas `prepaids` + `prepaid_uses`, migración 0023): la paciente paga antes para congelar el precio.
  N sesiones o saldo en plata (`sessions` NULL; cada sesión descuenta `unit_price`). La plata entra el día del pago como ingreso
  (`expenses` 'ingreso', concepto «Abono · …», `income_id`; no se edita/anula suelto). Texto: «carla dejó un abono de 5 sesiones de
  venus freeze, pagó 250000» (`prepaid-note.ts`). Sesión = `VisitInput.prepaidId`: ese renglón va a $0 y la profesional (cualquiera)
  cobra su parte sobre el precio congelado. «Plan» = abono (mismo concepto). Anotar pregunta si la paciente tiene uno («con abono»/«abonado»/«plan» = sí); «carla, plan» sin práctica
  usa la del plan (`prepaidItemId`; si tiene varios, pregunta cuál).
  Planilla: «+ Abono» en Otros ingresos (`AbonoForm`, `abonos.tsx`) y Medio «Abono» en la fila (al editar: `prepaidId` null = deja de serlo,
  sin la clave = sigue igual). Lista en Cierre y Planilla (`AbonosCard`).
- Lo que debe el consultorio (`domain/payables.ts`, tablas `payables` + `payable_payments`, migración 0024): a un proveedor, alquiler…
  Aviso `remind_mode` 'daily' (todos los días) o 'at' (`remind_at` AAAA-MM-DDTHH:MM); notificación `pagar` (admins + quien la anotó)
  y «Para pagar» arriba de Anotar hasta que se salda. Avisos de deudas (`deuda`, `deuda_cobrar`, `pagar`): todos los admins + quien la anotó. Pagar (todo o parte, con medio) = egreso de hoy; lo pagado sale de esos egresos
  (anular el egreso la reabre). Texto: «le debemos 300000 a la distribuidora, avisame todos los días / el 30/10 a las 10»,
  «le pagamos a la distribuidora» (`payable-note.ts`). Cierre y Planilla: «Lo que debemos» (`deudas-consultorio.tsx`).
- Obras sociales / prepagas (`domain/insurers.ts`, tablas `insurers` + `insurer_visits`, migración 0025 con OSMECON a $8.000):
  «limpieza a carla por osmecon, gabi» → `VisitInput.insurerId`: prácticas a $0 (productos se cobran), la profesional se lleva
  `provider_fee` una vez por atención (congelado en la venta y en `insurer_visits.fee`; dueña = 0). Sin práctica = «Atención».
  Planilla: Medio «OSMECON». Montos en Equipo → Obras sociales (`obras-sociales.tsx`, solo admin).
- Señas (`domain/deposits.ts`, tabla `deposits`, migración 0026): «carla dejó 20000 de seña para botox, viene el 28/10»
  (`deposit-note.ts`) o «+ Seña» (Planilla/Cierre, `senas.tsx`). Entra a la caja ese día (ingreso «Seña · …», `income_id`).
  La atención de esa paciente la descuenta sola (`VisitInput.depositId`): paga el resto, sin deuda; la profesional cobra sobre
  el total (resto + seña). «Hoy vienen con seña» arriba de Anotar (`due_on`). Usada = su `visit_id` con ventas vigentes.
- Egresos de plata: tabla `expenses` (`domain/expenses.ts`), los anota secretaría/admin; texto «pagué 5000 de luz» → `expense-note.ts`.
- Nueva migración = `NNNN_descripcion.sql`, nunca editar una ya aplicada. `migrate` activa RLS en todas
  las tablas de `public` (bloquea la API REST de Supabase); la app entra como dueña y no le afecta.
- Fechas: `realNowIso()` (zona `America/Argentina/Buenos_Aires`), timestamps TEXT.

```bash
npm run db:up && npm run db:migrate && npm run db:seed && npm run dev
npm run lint && npm run build
```
