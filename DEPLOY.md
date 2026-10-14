# Subir Klavdia · Stock a internet (gratis)

Tres servicios (más Gmail opcional), todos con plan gratis:

| Qué | Dónde | Para qué |
| --- | --- | --- |
| Código | **GitHub** (repo privado) | Guardar el código; Vercel lo toma de ahí |
| App | **Vercel** (plan Hobby) | La página que abre el consultorio |
| Base de datos | **Neon** (plan Free, se crea desde Vercel) | Postgres. ~0,5 GB: alcanza para años |
| Mails | **Gmail** del consultorio (opcional) | El código para recuperar la contraseña |

Tiempo: ~30 minutos. Necesitás la terminal en `~/Documents/decles-stock`.

> **Antes de empezar:**
> - **Vercel Hobby es solo para uso no comercial / personal.** Para que el consultorio lo *pruebe*, alcanza;
>   si lo adoptan para trabajar, corresponde pasar a **Pro** (USD 20/mes).
> - **Neon Free se duerme sin uso** y se despierta sola con el primer pedido (1–2 s la primera vez). No hay que hacer nada.

---

## 1. GitHub: subir el código

1. Entrá a **github.com → New repository**.
   - Nombre: `decles-stock` · **Private** · *no* marques README, .gitignore ni licencia.
2. En la terminal:
   ```bash
   cd ~/Documents/decles-stock
   git remote add origin https://github.com/TU-USUARIO/decles-stock.git
   git push -u origin main
   ```
   `.env.local` **no** se sube (está en `.gitignore`): tus claves quedan solo en tu Mac.

---

## 2. Base de datos: Neon (desde Vercel)

1. En Vercel, en tu proyecto `decles-stock`: pestaña **Storage → Create Database → Neon**.
   - Plan **Free** · Región **São Paulo** (o la más cercana) · nombre `decles-stock`.
2. **Connect Project** → elegí `decles-stock` (los tres entornos). Vercel carga solo las variables,
   entre ellas **`DATABASE_URL`** (la que usa la app, con *pooler*) y **`DATABASE_URL_UNPOOLED`** (directa).
3. **Crear las tablas** desde tu Mac. En *Storage → tu base → .env.local* (o en *Settings → Environment
   Variables*) copiá el valor de **`DATABASE_URL_UNPOOLED`** y corré, entre comillas:
   ```bash
   cd ~/Documents/decles-stock
   DATABASE_URL_DIRECT="postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require" npm run db:migrate
   ```
   Tiene que decir `Migraciones aplicadas: 0001_core, …, 0016_provider_payouts`.
   (Si la URL trae `&channel_binding=require`, dejalo: la app lo ignora.)
4. **No** corras `npm run db:seed`: es solo para tu base local (igual se niega a correr acá).

> **¿Supabase en vez de Neon?** También anda: en `DATABASE_URL` va el *Transaction pooler* (puerto 6543) y para
> migrar el *Session pooler* (5432). Ojo: Supabase Free se **pausa** a los 7 días sin uso y hay que reactivarla a mano.

---

## 3. Gmail: para que puedan recuperar la contraseña solos

Con esto, en el login aparece *¿Te olvidaste la contraseña?* y llega un código de 6 dígitos al mail de cada persona.
Conviene un Gmail **del consultorio** (no el personal de nadie), ej. `consultorio.decles@gmail.com`.

1. Entrá con ese Gmail a **myaccount.google.com → Seguridad** y activá la **Verificación en 2 pasos**
   (Google no da contraseñas de aplicación sin eso).
2. Andá a **myaccount.google.com/apppasswords** → nombre `Klavdia Stock` → **Crear**.
   Te muestra 16 letras (`abcd efgh ijkl mnop`). **Copialas**: no se vuelven a mostrar.
3. Las vas a pegar en Vercel en el paso siguiente (`SMTP_USER` y `SMTP_PASS`).

> Si cambian la contraseña de ese Gmail, Google anula la de aplicación: crear otra y actualizar `SMTP_PASS` en Vercel.
> Si no lo configurás, la app anda igual: la opción dice "no está activada" y el admin resetea desde Equipo.

---

## 4. Vercel: publicar la app

1. Si todavía no lo importaste: **vercel.com → Add New… → Project → Import** el repo `decles-stock`.
2. Framework: lo detecta solo (**Next.js**). No toques Build ni Output.
3. **Settings → Environment Variables** — agregá estas:

   | Nombre | Valor |
   | --- | --- |
   | `DATABASE_URL` | **Ya la puso Neon** (paso 2). No la toques |
   | `AUTH_SECRET` | Una clave al azar: en tu terminal corré `openssl rand -base64 48` y pegá el resultado |
   | `CRON_SECRET` | Otra clave al azar distinta (de nuevo `openssl rand -base64 48`) |
   | `SMTP_USER` | El Gmail del consultorio (paso 3) |
   | `SMTP_PASS` | La contraseña de aplicación de 16 letras (con o sin espacios) |

4. **Deployments → ⋯ → Redeploy** (las variables nuevas recién se usan en el próximo deploy).
   Te queda una URL tipo `decles-stock.vercel.app`.
5. **Región (recomendado):** *Settings → Functions → Function Region* → **São Paulo (gru1)**, así la app
   está al lado de la base y responde más rápido. Después: *Deployments → ⋯ → Redeploy*.

---

## 5. Primer uso

1. Abrí la URL de Vercel → aparece **Primer arranque**: nombre del consultorio, la cuenta del admin y **tu email**.
2. Seguí los **Primeros pasos** (productos y precios, stock con vencimientos, médicas con su comisión,
   secretaría, venta de prueba).
3. Pasale al consultorio la URL. Cada persona entra con el usuario y la contraseña temporal que le da el admin
   desde **Equipo**, elige la suya al entrar y carga su email (para recuperarla sola si se la olvida).
4. En el celular: abrir la URL → *Compartir → Agregar a inicio* y queda como una app.

El aviso diario de vencimientos ya está configurado (`vercel.json`, una vez por día, ~8 a 9 h de Argentina).
Lo ves en Vercel → *Settings → Cron Jobs*.

---

## Después: actualizar, migrar, respaldar

- **Cambios en el código:** `git push` → Vercel publica solo en ~1 minuto.
- **Si el cambio trae migraciones nuevas** (`src/lib/db/migrations/`), corré **antes** del push el mismo
  comando del paso 2.3 (con `DATABASE_URL_UNPOOLED`). Es idempotente: si no hay nada nuevo, no hace nada.
- **Backup:** Neon guarda un historial corto para restaurar (ver *Restore* en su panel). Igual conviene uno manual
  una vez por semana, desde tu Mac, con `DATABASE_URL_UNPOOLED`:
  ```bash
  pg_dump "postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require" --no-owner --schema=public > backup-$(date +%F).sql
  ```
  (Si no tenés `pg_dump`: `brew install libpq` y usá `$(brew --prefix libpq)/bin/pg_dump`.)
- **Si alguien pierde la contraseña:** *¿Te olvidaste la contraseña?* en el login (si tiene email cargado), o un admin
  la resetea desde Equipo. **Tené siempre dos admins**: si uno se la olvida, el otro lo resetea.
- **Si el único admin pierde la contraseña y no tiene email:** desde tu Mac,
  `DATABASE_URL="<DATABASE_URL_UNPOOLED>" npm run user:reset-password -- <usuario>` y te muestra una temporal.

## Si algo falla

| Síntoma | Causa probable |
| --- | --- |
| La página da error 500 al entrar | Falta `DATABASE_URL` (no conectaste Neon al proyecto) o no hiciste *Redeploy* después |
| «relation … does not exist» en los logs | No corriste `npm run db:migrate` contra Neon (paso 2.3) |
| "AUTH_SECRET is required in production" en los logs | Falta `AUTH_SECRET` o tiene menos de 32 caracteres |
| `db:migrate` no conecta | Revisá que pegaste la URL completa y entre comillas |
| "No se pudo mandar el mail" | `SMTP_PASS` mal copiada o anulada (cambiaron la contraseña del Gmail): crear otra de aplicación |
| "La recuperación por email no está activada" | Faltan `SMTP_USER`/`SMTP_PASS` en Vercel (y *Redeploy* después de agregarlas) |
