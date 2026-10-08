# Klavdia · Stock (Decles)

Stock, ventas y vencimientos del consultorio Decles. Es un **recorte de Clavdia**:
mismo stack, misma estética, **mismas tablas y columnas**, para poder integrarlo a
Clavdia cuando salga a producción sin migrar datos a mano.

## Quién hace qué

| Rol | Puede |
| --- | --- |
| **Admin** (cualquier rol con `admin_ids`) | Alta de productos con precio, ingresar lotes con vencimiento, editar precio/mínimo, dar de baja lotes (vencidos o pérdida), anular ventas, días de aviso de vencimiento |
| **Secretaría** (`recepcion`) | Solo vender: escribe en la hoja ("vendí 2 cremas pindonga y un protector") o toca el producto. Ve nombre y precio, nada de vencimientos ni stock |
| **Médica/o** (`medico`) | Vender igual que la secretaría + **campanita** con avisos de vencimientos y stock bajo |

Todo se valida en el servidor (`src/lib/domain/*`), no solo en la UI.

## Correr en local

Requisitos: Node 20+ y Docker.

```bash
npm install
cp .env.example .env.local
npm run db:up         # Postgres 16 en localhost:54329 (docker compose)
npm run db:migrate
npm run db:seed       # datos de demo — solo corre contra una base local
npm run dev           # http://localhost:3000
```

Usuarios de la demo (DNI / PIN): **Admin** 11111111 / 1111 · **Secretaría** 22222222 / 2222 ·
**Médica** 33333333 / 3333.

Empezar de cero: `docker compose down -v && npm run db:up && npm run db:migrate && npm run db:seed`.

## Producción (Vercel + Supabase)

1. Proyecto nuevo en Supabase. En Vercel: `DATABASE_URL` (pooled, 6543), `AUTH_SECRET`
   (32+ caracteres), `CRON_SECRET`, `RESEND_API_KEY` + `RESEND_FROM` (para el código de "Me lo olvidé").
2. `DATABASE_URL_DIRECT=... npm run db:migrate`
3. Alta del equipo (nadie reparte PINs: cada persona entra por «Me lo olvidé» y elige el suyo):
   ```bash
   npm run user:create -- --org "Consultorio Decles" --name "Nombre" --dni 30111222 --email x@y.com --role recepcion --admin
   npm run user:create -- --org "Consultorio Decles" --name "Dra. ..." --dni ... --email ... --role medico
   ```
4. El cron diario (`vercel.json` → `/api/cron/stock-alerts`) genera los avisos. También se
   recalculan después de cada venta/ingreso y cuando la médica abre la app.

## Cómo está armado

```
src/lib/db/migrations/   0001_core · 0002_stock · 0003_billing  (= Clavdia)
                         0004_notifications                     (nueva)
src/lib/domain/
  stock.ts         = Clavdia (lotes, FEFO, bajas, permisos)
  billing.ts       = Clavdia + `expiresOn` opcional al vender; sin resúmenes de finanzas
  products.ts      nuevo: producto vendible = stock_item + price_list_item (alta/edición en un paso)
  notifications.ts nuevo: avisos de vencimiento / vencido / stock bajo para los médicos
  quick-sale.ts    nuevo: intérprete SIN IA de la hoja de ventas (cantidad + producto por
                   coincidencia de palabras, plurales y errores de tipeo; ante la duda pregunta)
src/app/
  vender-view.tsx · inventario-view.tsx · ventas-view.tsx · bell.tsx · stock-app.tsx
  login/, ui.tsx, globals.css   (= Clavdia, recortados)
```

## Integración con Clavdia

Diferencias concretas contra Clavdia, todo lo demás es igual:

1. **Migración nueva**: copiar `0004_notifications.sql` a Clavdia con el próximo número libre.
2. **`consumeStockFefo`** (`stock-repo.ts`) acepta `preferExpiry`; **`recordSale`** (`billing.ts`)
   acepta `expiresOn`. Son parámetros opcionales, no rompen a los callers actuales.
3. **`stock_roles`** acá arranca en `'[]'` (solo el admin toca inventario). En Clavdia el default es
   `'["medico","recepcion"]'`: al migrar, setear `'[]'` para Decles.
4. `stock_movements.appointment_id / consultation_id` acá no tienen FK (esas tablas no existen).
   En Clavdia sí; como acá siempre quedan `NULL`, las filas pasan sin conflicto.
5. Cookie de sesión `decles_stock_session` (en Clavdia `clinic_session`), para que las dos apps
   no se pisen en local.
6. `products.ts`, `notifications.ts`, `bell.tsx` y `vender-view.tsx` se pueden llevar tal cual
   (la campanita y la pantalla de venta rápida sirven igual en Clavdia).

Pasar los datos: dump de `organizations`, `users`, `memberships`, `providers`, `stock_*`,
`price_*`, `sales` y `notifications` e import en la base de Clavdia (los IDs son TEXT con
prefijo y no colisionan).
