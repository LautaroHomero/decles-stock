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
- Diseño monocromo (negro y blanco, Inter): tokens `--cl-*` en `globals.css`; acción principal `bg-accent text-on-accent`.
- Pestaña **Planilla** (antes «Ventas», `ventas-view.tsx`). Día = `planilla-view.tsx` (filas por área) + `planilla-movimientos.tsx`
  (otros ingresos, egresos y pagos a profesionales, quedaron debiendo, resumen entró/salió/queda y medios).
- Planilla: `planilla-view.tsx` = Planilla → Día (filas por área); `cierre-sheet.tsx` = Cierre (números del día, por profesional, ingresos/egresos extras, caja, medios de pago). Áreas = `providers.area`; fila = visita con
  `amount`/`commission` manuales (`applyManualAmounts`), «Atención» sin práctica (`generic`). Fila = paciente · qué pagó (práctica/producto) · médica · pagó $ · medio (+ $K fuera de Médicos).
  Ingresos extras = `expenses.direction 'ingreso'`; caja = `day_cash` (`opening` = cambio al iniciar, se le pregunta a la secretaria al entrar — `opening-cash.tsx`; `amount` = contado al cambio). Pago: efectivo | transferencia | tarjeta.
- Plata al anotar (`money-note.ts`): la secretaria dice cuánto ingresó («45000», «pagó 40 mil»); el reparto lo hace el
  sistema (% de la profesional) salvo que lo aclare («le corresponden 9000»). «le transfirieron a carmen» / «abono» = ingresó $0.
  Se guarda con `amount`/`commission` manuales; resolver un pendiente no pisa lo escrito.
- Pagos a profesionales (`domain/payouts.ts`, tabla `provider_payouts`): «le pagué todo a Carmen» (Anotar, `parsePayout`) o
  «Pagar todo» en Cierre. Debe = su parte del día ($K) − pagado. Sale de la caja. Cierre = entró / salió / movimientos.
- Deudas (`domain/debts.ts`, tablas `debts` + `debt_payments`): alguien le debe al consultorio. «botox a carla, gabi, pagó 80000,
  debe 40000» (`VisitInput.debt`) o suelta «carla debe 40000»; se cobra «carla pagó la deuda» (`parseDebtPayment`) o «Cobrar» en
  Cierre. Cada cobro entra a la caja del día en que se paga y suma la parte de la profesional (`share`) a lo que se le debe ese día.
  Aviso `deuda` para los admins mientras esté abierta (se va al saldarse).
  Partes sin importe: «la mitad en efectivo y la mitad con tarjeta», «debe la otra mitad», «30% tarjeta» → `MoneyNote.fractions`
  (`fractionsToPesos` sobre el precio o lo que dijo que pagó). La vista manual y «Editar detalles» también tienen varios medios y «Queda debiendo».
- Egresos de plata: tabla `expenses` (`domain/expenses.ts`), los anota secretaría/admin; texto «pagué 5000 de luz» → `expense-note.ts`.
- Nueva migración = `NNNN_descripcion.sql`, nunca editar una ya aplicada. `migrate` activa RLS en todas
  las tablas de `public` (bloquea la API REST de Supabase); la app entra como dueña y no le afecta.
- Fechas: `realNowIso()` (zona `America/Argentina/Buenos_Aires`), timestamps TEXT.

```bash
npm run db:up && npm run db:migrate && npm run db:seed && npm run dev
npm run lint && npm run build
```
