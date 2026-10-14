import nodemailer, { type Transporter } from "nodemailer";

/**
 * Mails salientes (solo el código para recuperar la contraseña).
 *
 * Gratis con un Gmail del consultorio + "contraseña de aplicación":
 *   SMTP_USER=consultorio@gmail.com  SMTP_PASS=abcd efgh ijkl mnop
 * Otro proveedor: SMTP_HOST / SMTP_PORT. Remitente visible: MAIL_FROM (opcional).
 *
 * Sin SMTP configurado: en desarrollo el mail se imprime en la consola de `npm run dev`;
 * en producción la recuperación por email queda apagada (la pantalla lo dice).
 */
export type MailMode = "smtp" | "console" | "off";

const env = (k: string) => (process.env[k] ?? "").trim();
/** La contraseña de aplicación de Google viene con espacios («abcd efgh ijkl mnop»): se sacan. */
const smtpPass = () => env("SMTP_PASS").replace(/\s+/g, "");

export function mailMode(): MailMode {
  if (env("SMTP_USER") && smtpPass()) return "smtp";
  return process.env.NODE_ENV === "production" ? "off" : "console";
}

let transport: Transporter | null = null;

function smtp(): Transporter {
  if (!transport) {
    const port = Number(env("SMTP_PORT")) || 465;
    transport = nodemailer.createTransport({
      host: env("SMTP_HOST") || "smtp.gmail.com",
      port,
      secure: port === 465, // 465 = SSL directo; 587 = STARTTLS (obligatorio)
      requireTLS: port !== 465,
      auth: { user: env("SMTP_USER"), pass: smtpPass() },
      // En Vercel la función no puede quedarse colgada esperando al servidor de mail.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transport;
}

export async function sendMail(m: { to: string; subject: string; text: string }): Promise<boolean> {
  const mode = mailMode();
  if (mode === "off") return false;
  if (mode === "console") {
    console.log(`\n✉️  [mail de desarrollo] para ${m.to}\n   ${m.subject}\n\n${m.text}\n`);
    return true;
  }
  try {
    // Gmail solo deja mandar como la misma cuenta (o un alias verificado): MAIL_FROM cambia sobre todo el nombre visible.
    const from = env("MAIL_FROM") || `Klavdia · Stock <${env("SMTP_USER")}>`;
    await smtp().sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    return true;
  } catch (e) {
    console.error("No se pudo mandar el mail:", e instanceof Error ? e.message : e);
    return false;
  }
}
