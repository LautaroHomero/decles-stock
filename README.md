# Klavdia · Stock (Decles)

Pacientes, prácticas, ventas, stock, comisiones y vencimientos del consultorio Decles. Es un **recorte de Clavdia**:
mismo stack, misma estética y **mismas tablas** (más columnas aditivas), para integrarlo a
Clavdia cuando salga a producción sin migrar datos a mano.

## Quién hace qué

| Rol | Puede |
| --- | --- |
| **Admin** (cualquier persona marcada como admin) | Equipo: alta y baja de médicas y secretarias, reset de contraseña, % de comisión. Stock: productos con precio, lotes con vencimiento, bajas. Ventas: ver todo, comisiones por médica, anular |
| **Secretaría** | **Anotar**: escribe lo que pasó ("María López, la atendió Laura, atención y peeling" / "gabriela vendió 2 cremas con tarjeta") o lo elige de una lista en pasos; confirma y listo. Ve el **cierre del día** y Ventas |
| **Médica/o** | Anota a su nombre, ve el stock, su comisión, su cierre del día y la **campanita** con vencimientos y stock bajo |

Todo se valida en el servidor (`src/lib/domain/*`), no solo en la UI.

## Login

- **Usuario + contraseña** (scrypt con sal por usuario).
- **Primer arranque**: con la base vacía, la app pide el nombre del consultorio y crea la cuenta del primer admin.
- **Altas**: el admin crea a la persona y recibe una **contraseña temporal** (se muestra una sola vez). Al entrar,
  la persona elige la suya; hasta entonces no puede hacer nada más.
- **Olvidó la contraseña** (sola): *¿Te olvidaste la contraseña?* → usuario o email → llega un **código de 6 dígitos**
  al mail → elige una nueva y entra. Vale el último código, 15 min, 5 intentos; hasta 5 por hora. Cierra sus otras sesiones
  y desbloquea la cuenta. Cada persona carga su email al entrar por primera vez, en *Mi email* o el admin en Equipo.
  Los mails salen de un Gmail del consultorio (`SMTP_USER`/`SMTP_PASS`, ver DEPLOY.md); sin eso, en desarrollo el código
  sale en la consola de `npm run dev` y en producción la opción avisa que no está activada.
- **O el admin** la resetea desde Equipo (nueva temporal).
- **Baja**: lógica (el historial conserva el nombre). Cierra sus sesiones al instante.
- **Sesión**: 30 días en cada equipo (una baja o un reset la cortan al instante).
- **Bloqueo**: 5 intentos fallidos → 15 min.
- **Si el único admin perdió la contraseña**: `npm run user:reset-password -- <usuario>` en la máquina donde corre.

## Anotar y cierre del día

- **Anotar** (pantalla principal, para todos), con la menor cantidad de toques:
  - Texto libre con **vista previa en vivo** (paciente, médica, ítems, total). Si está todo claro: **Guardar** (o Enter),
    un solo toque. Lo dudoso se contesta ahí mismo con un toque («¿cuál crema?», «¿es la paciente?», «¿quién la atendió?»).
    "Editar detalles" abre la revisión completa (cantidades, precio de lo no cargado), opcional.
  - "Prefiero elegirlo de una lista": **una sola pantalla** — médica, ítems (con +/−), pago opcional, Guardar.
  - Al guardar: animación «¡Registrado!» y vuelve solo al inicio, con la fila nueva resaltada en «Hoy».
  - Si lo anotado es de una sola médica (vínculos del admin), la pone sola.
- El **paciente es solo un nombre** escrito (no hay fichas). Las **prácticas** (atención, peeling…) las carga el admin en
  Stock → Prácticas con precio efectivo y con tarjeta; generan comisión igual que un producto.
- Todo lo anotado junto se guarda junto (`visit_id`): **o se anota todo o nada** (si no alcanza el stock de un producto, no se
  anota ninguna línea).
- **Cierre del día**: pacientes, prácticas, lo cobrado (por medio de pago) y el detalle por médica. Se imprime.
- **Ayuda para escribir**: mientras se escribe aparecen sugerencias para completar la palabra (práctica/producto, médica,
  medio de pago); Tab o un toque la completa. Entiende sinónimos del consultorio (botox → toxina botulínica, prp, crio,
  rf, fps, dermapen…), letras invertidas («peelnig»), números pegados («2cremas»), «un par» y el pago mal escrito.
- **Nada se pierde por un error de escritura o de carga**:
  - Tipeo: entiende tildes, plurales, palabras cortadas, una letra de más/menos/cambiada (dos en palabras largas) y
    errores de sonido (v/b, s/z/c, ll/y, h). Si no entiende algo: elegir de opciones, **buscar en la lista**,
    **anotarlo igual** (pendiente) o quitarlo.
  - Paciente dudoso: si el "nombre" es una sola palabra o no se anotó nada más («hilos tensores, laura»), pregunta si
    es la paciente o lo que se hizo.
  - **Pendientes**: lo que no está en la lista se guarda con el nombre escrito, sin importe. Al admin le llega el aviso y
    lo resuelve arriba de Stock ("Es «X»", elegir de la lista o crearlo con precio); ahí toma precio y comisión.
  - **Sin stock cargado**: se vende igual; el stock queda negativo (`stock_items.owed`) y avisa al admin. El próximo
    ingreso lo compensa solo.
- **Editar lo anotado**: tocando la fila en «Hoy» o «Editar» en Ventas (paciente, médica, ítems, cantidades, pago). Se
  reemplaza la anotación (el stock se devuelve y se vuelve a descontar, la comisión se recalcula; la vieja queda con
  status `edited` y no se lista). Lo del día: cualquiera (la médica, lo suyo); días anteriores: solo el admin.
- **Comisión por ítem**: cada práctica o producto puede tener su propio % (`price_list_items.commission_pct`, 0012). Si
  no tiene, se usa el % de la médica. Se congela en la venta.
- **Parte de cada profesional en un ítem** (0018): si dos o más hacen lo mismo y se llevan distinto, a cada una se le
  carga un % o una plata fija por unidad (`price_item_providers.commission_pct` / `commission_fixed`). Orden: eso, el %
  del ítem, el % de la profesional (`commissionFor` en `domain/billing.ts`). La plata fija se congela en
  `sales.commission_fixed` (corregir el importe no la recalcula; si ingresó $0, 0). Al anotar se puede pisar igual.
- **Deudas** (0019): `debts` (quién, cuánto, por qué, profesional y su parte, anotación) y `debt_payments` (cobros, en
  partes, con medio). Lo cobrado entra a la caja del día del cobro (Cierre: Entró, efectivo esperado, medios) y la
  profesional cobra su parte ese día (`payouts`). Aviso `deuda` en la campanita de los admins hasta que se salda.
  Recordatorio (0021): `debts.remind_on`; ese día aviso `deuda_cobrar` y «Para cobrar hoy» en Anotar.
- **Pago directo a la profesional** (0030): medio `profesional` en `sales`/`visit_payments`; `provider_payouts.direction` (pago|cobro) y `provider_debts.direction` (consultorio|profesional).
- **Señas** (0026): `deposits` (paciente, práctica, monto, día del turno, `visit_id` donde se descontó).
- **Obras sociales** (0025): `insurers` (nombre, `provider_fee` por atención) e `insurer_visits` (atención ↔ obra social).
- **Lo que debemos** (0024): `payables` (a quién, cuánto, aviso diario o fecha y hora) y `payable_payments` (pago ↔ egreso).
- **Abonos** (0023): `prepaids` (paquete: sesiones o saldo, precio congelado) y `prepaid_uses` (sesión ↔ `visit_id`).
- **Deudas con profesionales** (0022): `provider_debts` («le quedamos debiendo»); se pagan con `provider_payouts.provider_debt_id`.
  `provider_payouts.method` y `expenses.method`: solo el efectivo cuenta en la caja.
- **Vencimientos**: `parseExpiry` vive en `domain/expiry.ts` (acepta también `03/27` y `15/03/27`); el calendario es
  `expiry-picker.tsx` (abre en meses: un toque = fin de mes; después el día).
- **Catálogo de prueba**: `npm run db:catalogo` carga 14 prácticas y 12 productos (con stock y vencimientos) en el
  consultorio que ya tengas en la base local. No borra ni duplica.
- **Quién hace qué**: el admin vincula cada práctica y cada producto a las médicas que lo hacen o venden (Stock →
  editar → "¿Quién lo hace o lo vende?"). Sin marcar = cualquiera. Al anotar a mano, después de elegir la médica se ven
  solo sus ítems; si se escribe algo que no tiene asignado, la confirmación lo marca y el servidor lo rechaza.

## Precios, medio de pago y comisiones

- Cada producto tiene **precio efectivo/transferencia** (el mismo) y **precio con tarjeta** (vacío = igual).
- Al vender, el medio de pago es **opcional** (botón o escrito en la hoja: "con tarjeta", "efectivo", "transferencia").
  Si no se carga, la venta guarda los dos valores y Ventas muestra "$X, o $Y si fue con tarjeta"; se puede completar después.
- Cada médica tiene un % (lo fija el admin en Equipo), **siempre sobre el precio en efectivo**: el recargo de tarjeta no
  cambia la comisión y se sabe exacta aunque falte el medio. % y monto se **congelan** en la venta.

## Primeros pasos (onboarding)

Después del primer arranque, el admin ve un checklist de 7 pasos que se tildan solos al hacerlos: su email, prácticas, productos con precio,
stock con vencimiento, médicas con comisión, secretaría y una venta de prueba. Se oculta y se reabre desde el menú de la cuenta.

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

Paso a paso, con las variables para copiar: **[DEPLOY.md](DEPLOY.md)**.

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
                         0004_notifications · 0005_accounts_commissions · 0006_user_aliases
                         0007_payment_methods · 0008_onboarding · 0009_visits · 0010_item_providers · 0011_pending_owed · 0012_item_commission   (nuevas)
src/lib/auth/            session (cookie firmada + session_version), password (scrypt), actor
src/lib/domain/
  accounts.ts      primer arranque, login, contraseña (y recuperación por código), equipo (alta/baja/reset/comisión)
  stock.ts         = Clavdia (lotes, FEFO, bajas, permisos)
  billing.ts       = Clavdia + médica obligatoria y comisión congelada; resumen de comisiones
  products.ts      producto vendible = stock_item + price_list_item (alta/edición en un paso)
  notifications.ts avisos de vencimiento / vencido / stock bajo para las médicas
  quick-sale.ts    intérprete SIN IA: paciente, prácticas/productos, cantidad, médica (con diminutivos/apodos) y medio de pago
  visits.ts        anotar todo junto (paciente + médica + renglones), todo o nada
  day-close.ts     cierre del día
  onboarding.ts    "Primeros pasos" del admin
```

## Integración con Clavdia

Diferencias concretas contra Clavdia; todo lo demás es igual:

1. **Migraciones nuevas**: `0004` a `0030` (solo agregan tablas/columnas). Prácticas = `price_list_items.kind = 'tratamiento'`
   (sin stock). `sales.patient_label` (paciente escrito; en Clavdia se puede mapear a `patient_id`) y `sales.visit_id`.
   `price_item_providers` (0010): qué médicas ofrecen cada ítem (distinto de `price_list_items.provider_id` de Clavdia).
   0011: `stock_items.owed` (vendido sin stock) y `sales.kind = 'pendiente'` con `item_id` NULL (se resuelve después).
   `recordSale` acepta `allowNoStock` (opcional). `price_list_items.amount` sigue siendo el
   precio base (efectivo); `card_amount` es nuevo. `sales.total` = lo cobrado; `cash_total`/`card_total`/`payment_method` nuevos.
2. **Login**: Clavdia entra con DNI/email + PIN. Al integrar, o se suma usuario+contraseña a Clavdia, o se completa
   `email`/`dni` de estas cuentas para que entren con el login de Clavdia. `session_version` conviene llevarlo igual.
3. **`recordSale`** acepta `expiresOn` y, para productos, exige médica (`providerId`) y guarda la comisión.
   **`consumeStockFefo`** acepta `preferExpiry`. Parámetros opcionales para los callers existentes.
4. **`stock_roles`** acá arranca en `'[]'` (solo el admin toca inventario); en Clavdia setearlo así para Decles.
5. `stock_movements.appointment_id / consultation_id` acá no tienen FK; siempre quedan `NULL`.
6. Cookie `decles_stock_session` (en Clavdia `clinic_session`).
7. Recuperar contraseña usa la tabla de Clavdia `pin_reset_codes` (`channel = 'email'`) y `users.email`; mails con
   nodemailer/SMTP (`src/lib/mail.ts`). En Clavdia se puede cambiar por su envío de mails.

Pasar los datos: dump de `organizations`, `users`, `memberships`, `providers`, `stock_*`, `price_*`, `sales` y
`notifications` e import en la base de Clavdia (los IDs son TEXT con prefijo y no colisionan).
