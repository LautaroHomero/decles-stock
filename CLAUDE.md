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
- Anotar = `recordVisit` (`domain/visits.ts`): renglones con el mismo `visit_id`, todo o nada. Paciente = texto libre.
  Lo no cargado = venta `kind 'pendiente'` (resuelve el admin, `domain/pending.ts`); sin stock = `stock_items.owed`.
- Diseño monocromo (negro y blanco, Inter): tokens `--cl-*` en `globals.css`; acción principal `bg-accent text-on-accent`.
- Planilla (`planilla-view.tsx`): la hoja en papel. `part="lista"` = Ventas → Día (filas por área); `part="cierre"` = Cierre (ingresos/egresos extras, caja, totales por profesional, resumen). Áreas = `providers.area`; fila = visita con
  `amount`/`commission` manuales (`applyManualAmounts`), «Atención» sin práctica (`generic`). Fila = paciente · qué pagó (práctica/producto) · médica · pagó $ · medio (+ $K fuera de Médicos).
  Ingresos extras = `expenses.direction 'ingreso'`; caja al cambio = `day_cash`. Pago: efectivo | transferencia | tarjeta.
- Egresos de plata: tabla `expenses` (`domain/expenses.ts`), los anota secretaría/admin; texto «pagué 5000 de luz» → `expense-note.ts`.
- Nueva migración = `NNNN_descripcion.sql`, nunca editar una ya aplicada. `migrate` activa RLS en todas
  las tablas de `public` (bloquea la API REST de Supabase); la app entra como dueña y no le afecta.
- Fechas: `realNowIso()` (zona `America/Argentina/Buenos_Aires`), timestamps TEXT.

```bash
npm run db:up && npm run db:migrate && npm run db:seed && npm run dev
npm run lint && npm run build
```
