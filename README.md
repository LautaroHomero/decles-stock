# Klavdia · Stock (Decles)

Stock, ventas, comisiones y vencimientos del consultorio Decles. Es un **recorte de Clavdia**:
mismo stack, misma estética y **mismas tablas** (más columnas aditivas), para integrarlo a
Clavdia cuando salga a producción sin migrar datos a mano.

## Quién hace qué

| Rol | Puede |
| --- | --- |
| **Admin** (cualquier persona marcada como admin) | Equipo: alta y baja de médicas y secretarias, reset de contraseña, % de comisión. Stock: productos con precio, lotes con vencimiento, bajas. Ventas: ver todo, comisiones por médica, anular |
| **Secretaría** | Solo vender: elige **qué médica vendió**, escribe en la hoja ("vendí 2 cremas pindonga") o toca el producto. Ve nombre y precio |
| **Médica/o** | Vende a su nombre, ve el stock, su comisión y la **campanita** con vencimientos y stock bajo |

Todo se valida en el servidor (`src/lib/domain/*`), no solo en la UI.

## Login

- **Usuario + contraseña** (scrypt con sal por usuario). Sin emails: funciona sin internet.
- **Primer arranque**: con la base vacía, la app pide el nombre del consultorio y crea la cuenta del primer admin.
- **Altas**: el admin crea a la persona y recibe una **contraseña temporal** (se muestra una sola vez). Al entrar,
  la persona elige la suya; hasta entonces no puede hacer nada más.
- **Olvidó la contraseña**: el admin la resetea desde Equipo (nueva temporal).
- **Baja**: lógica (el historial conserva el nombre). Cierra sus sesiones al instante.
- **Bloqueo**: 5 intentos fallidos → 15 min.
- **Si el único admin perdió la contraseña**: `npm run user:reset-password -- <usuario>` en la máquina donde corre.

## Comisiones

Cada médica tiene un % (lo fija el admin en Equipo). En cada venta se **congela** el % y el monto: cambiar
el % después no reescribe ventas anteriores. Una venta anulada no suma comisión.

## Instalación

### En la PC del consultorio (o un servidor propio)

Requisito: Docker Desktop.

```bash
echo "AUTH_SECRET=$(openssl rand -base64 48)" > .env
npm run app:up        # = docker compose --profile app up -d --build
```

Abrir http://localhost:3000 (o `http://<IP-de-esa-PC>:3000` desde otra compu o el celular en la misma red) y completar
el primer arranque. Se reinicia solo con la PC. Los datos viven en el volumen `db-data` de Docker:
**backup** con `docker compose exec db pg_dump -U decles decles_stock > backup.sql`.

### Hosteado (Vercel + Supabase)

1. Proyecto en Supabase. En Vercel: `DATABASE_URL` (pooled, 6543), `AUTH_SECRET` (32+ caracteres), `CRON_SECRET`.
2. `DATABASE_URL_DIRECT=... npm run db:migrate`
3. Entrar a la URL y completar el primer arranque.

### Desarrollo

```bash
npm install
cp .env.example .env.local
npm run db:up && npm run db:migrate && npm run db:seed && npm run dev
```

Demo (contraseña `decles123` para todos): `admin` (admin), `sofia` (secretaría), `laura` (médica 10%), `paula` (médica 8%).
Empezar de cero: `docker compose down -v && npm run db:up && npm run db:migrate && npm run db:seed`.

## Cómo está armado

```
src/lib/db/migrations/   0001_core · 0002_stock · 0003_billing   (= Clavdia)
                         0004_notifications · 0005_accounts_commissions   (nuevas)
src/lib/auth/            session (cookie firmada + session_version), password (scrypt), actor
src/lib/domain/
  accounts.ts      primer arranque, login, contraseña, equipo (alta/baja/reset/comisión)
  stock.ts         = Clavdia (lotes, FEFO, bajas, permisos)
  billing.ts       = Clavdia + médica obligatoria y comisión congelada; resumen de comisiones
  products.ts      producto vendible = stock_item + price_list_item (alta/edición en un paso)
  notifications.ts avisos de vencimiento / vencido / stock bajo para las médicas
  quick-sale.ts    intérprete SIN IA de la hoja de ventas
```

## Integración con Clavdia

Diferencias concretas contra Clavdia; todo lo demás es igual:

1. **Migraciones nuevas**: `0004_notifications.sql` y `0005_accounts_commissions.sql` (solo agregan tablas/columnas).
2. **Login**: Clavdia entra con DNI/email + PIN. Al integrar, o se suma usuario+contraseña a Clavdia, o se completa
   `email`/`dni` de estas cuentas para que entren con el login de Clavdia. `session_version` conviene llevarlo igual.
3. **`recordSale`** acepta `expiresOn` y, para productos, exige médica (`providerId`) y guarda la comisión.
   **`consumeStockFefo`** acepta `preferExpiry`. Parámetros opcionales para los callers existentes.
4. **`stock_roles`** acá arranca en `'[]'` (solo el admin toca inventario); en Clavdia setearlo así para Decles.
5. `stock_movements.appointment_id / consultation_id` acá no tienen FK; siempre quedan `NULL`.
6. Cookie `decles_stock_session` (en Clavdia `clinic_session`).

Pasar los datos: dump de `organizations`, `users`, `memberships`, `providers`, `stock_*`, `price_*`, `sales` y
`notifications` e import en la base de Clavdia (los IDs son TEXT con prefijo y no colisionan).
