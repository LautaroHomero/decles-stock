# Subir Klavdia · Stock a internet (gratis)

Cuatro servicios, todos con plan gratis:

| Qué | Dónde | Para qué |
| --- | --- | --- |
| Código | **GitHub** (repo privado) | Guardar el código; Vercel lo toma de ahí |
| Base de datos | **Supabase** (plan Free) | Postgres. 500 MB y 2 proyectos activos |
| App | **Vercel** (plan Hobby) | La página que abre el consultorio |
| Mails | **Gmail** del consultorio | El código para recuperar la contraseña (~500 mails/día) |

Tiempo: ~40 minutos. Necesitás la terminal en `~/Documents/decles-stock`.

> **Antes de empezar, dos límites de los planes gratis:**
> - **Vercel Hobby es solo para uso no comercial / personal.** Para que el consultorio lo *pruebe*, alcanza;
>   si lo adoptan para trabajar, corresponde pasar a **Pro** (USD 20/mes) o mudar el hosting.
> - **Supabase Free pausa el proyecto tras 7 días sin uso.** Un consultorio que vende a diario no llega a eso;
>   si se pausa, se reactiva desde el panel de Supabase con un clic (los datos no se pierden).

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

## 2. Supabase: crear la base (en la cuenta que vayas a usar)

1. **supabase.com → New project**
   - Nombre: `decles-stock`
   - **Database password:** tocá *Generate a password* y **guardala** (la vas a necesitar dos veces).
     Si la escribís vos, usá solo letras y números (los símbolos rompen la URL de conexión).
   - **Region:** `South America (São Paulo)`.
   - Plan: **Free**.
2. Esperá a que diga *Healthy* (1–2 min).
3. Arriba tocá **Connect** → pestaña **Connection string** → **URI**. Vas a copiar dos:
   - **Transaction pooler** (puerto **6543**) → es la que usa la app (`DATABASE_URL`).
   - **Session pooler** (puerto **5432**) → es la que usás para crear las tablas desde tu Mac.
   En las dos, reemplazá `[YOUR-PASSWORD]` por la contraseña de la base.
   > No uses la "Direct connection" (`db.xxxx.supabase.co`): en el plan gratis solo anda por IPv6 y
   > desde tu casa probablemente no conecte.
4. **Crear las tablas** desde tu Mac (pegá la del *Session pooler*, entre comillas):
   ```bash
   cd ~/Documents/decles-stock
   DATABASE_URL_DIRECT="postgresql://postgres.xxxx:CONTRASEÑA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" npm run db:migrate
   ```
   Tiene que decir `Migraciones aplicadas: 0001_core, …, 0008_onboarding`.
   Además, en cada migrate se bloquea la API pública de Supabase (RLS en todas las tablas): nadie
   puede leer los datos con la clave pública; la app entra directo con el usuario de la base.
5. **No** corras `npm run db:seed`: es solo para tu base local (igual se niega a correr acá).

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

1. **vercel.com → Add New… → Project → Import** el repo `decles-stock` (la primera vez te pide
   conectar tu GitHub).
2. Framework: lo detecta solo (**Next.js**). No toques Build ni Output.
3. **Environment Variables** — agregá estas antes de tocar *Deploy*:

   | Nombre | Valor |
   | --- | --- |
   | `DATABASE_URL` | La del **Transaction pooler** (puerto **6543**), con la contraseña puesta |
   | `AUTH_SECRET` | Una clave al azar: en tu terminal corré `openssl rand -base64 48` y pegá el resultado |
   | `CRON_SECRET` | Otra clave al azar distinta (de nuevo `openssl rand -base64 48`) |
   | `SMTP_USER` | El Gmail del consultorio (paso 3) |
   | `SMTP_PASS` | La contraseña de aplicación de 16 letras (con o sin espacios) |

4. **Deploy.** En 1–2 minutos te da una URL tipo `decles-stock.vercel.app`.
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
  comando del paso 2.4 (con la URL del *Session pooler*). Es idempotente: si no hay nada nuevo, no hace nada.
- **Backup manual** (recomendado una vez por semana), desde tu Mac, con la URL del *Session pooler*:
  ```bash
  pg_dump "postgresql://postgres.xxxx:CONTRASEÑA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" \
    --no-owner --schema=public > backup-$(date +%F).sql
  ```
  (Si no tenés `pg_dump`: `brew install libpq` y usá `$(brew --prefix libpq)/bin/pg_dump`.)
- **Si alguien pierde la contraseña:** *¿Te olvidaste la contraseña?* en el login (si tiene email cargado), o un admin
  la resetea desde Equipo. **Tené siempre dos admins**: si uno se la olvida, el otro lo resetea.
- **Si el único admin pierde la contraseña y no tiene email:** desde tu Mac,
  `DATABASE_URL="<session pooler>" npm run user:reset-password -- <usuario>` y te muestra una temporal.

## Si algo falla

| Síntoma | Causa probable |
| --- | --- |
| La página da error 500 al entrar | `DATABASE_URL` mal copiada (falta la contraseña, o es la de 5432 en vez de 6543) |
| "AUTH_SECRET is required in production" en los logs | Falta `AUTH_SECRET` o tiene menos de 32 caracteres |
| `db:migrate` no conecta | Estás usando la *Direct connection*; usá la del *Session pooler* |
| La app dejó de andar después de una semana sin uso | Supabase pausó el proyecto: *Restore* en el panel |
| "No se pudo mandar el mail" | `SMTP_PASS` mal copiada o anulada (cambiaron la contraseña del Gmail): crear otra de aplicación |
| "La recuperación por email no está activada" | Faltan `SMTP_USER`/`SMTP_PASS` en Vercel (y *Redeploy* después de agregarlas) |
