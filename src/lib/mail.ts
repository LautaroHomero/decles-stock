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

export function mailMode(): MailMode {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  return process.env.NODE_ENV === "production" ? "off" : "console";
}

let transport: Transporter | null = null;

function smtp(): Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: (process.env.SMTP_PASS ?? "").replace(/\s+/g, "") },
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
    const from = process.env.MAIL_FROM || `Klavdia · Stock <${process.env.SMTP_USER}>`;
    await smtp().sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    return true;
  } catch (e) {
    console.error("No se pudo mandar el mail:", e instanceof Error ? e.message : e);
    return false;
  }
}
