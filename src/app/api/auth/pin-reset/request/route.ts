import { randomInt } from "node:crypto";
import {
  activePinResetCode,
  createPinResetCode,
  findLogin,
  getOrganization,
  getPatient,
  membershipsForUser,
  patientOrgs,
} from "@/lib/db/repo";
import { hashPin as hashCode } from "@/lib/auth/pin";
import { getNotifier, toE164, whatsappCredentialsSet, type NotifyChannel } from "@/lib/notify";

/**
 * Step 1 of patient PIN recovery: send a one-time code to the email (or, if
 * asked and available, the phone) already on the patient's ficha.
 *
 * The response is deliberately identical whether or not the account exists, so
 * this endpoint can't be used to probe which emails / DNIs are registered.
 */
const GENERIC = {
  ok: true as const,
  message:
    "Si los datos corresponden a una cuenta, te enviamos un código para restablecer el PIN. Vence en 10 minutos.",
};
const CODE_TTL_MIN = 10;
const RESEND_COOLDOWN_MS = 60_000;

const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  if (!d) return "***";
  return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
};
const maskPhone = (p: string) => {
  const digits = p.replace(/\D/g, "");
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : "•••";
};

export async function POST(req: Request) {
  const { email, dni, channel } = (await req.json().catch(() => ({}))) as {
    email?: string;
    dni?: string;
    channel?: NotifyChannel;
  };
  if (!email?.trim() && !dni?.trim()) {
    return Response.json({ ok: false, error: "Indicá tu email o DNI." }, { status: 400 });
  }

  // Server-side only — the HTTP response stays identical regardless. Helps in
  // dev (the LogNotifier transport) to see why a code wasn't sent.
  const trace = (why: string) => console.info(`[pin-reset] sin envío: ${why}`);

  const user = await findLogin({ email: email?.trim(), dni: dni?.trim() });
  if (!user) {
    trace("ninguna cuenta para ese email/DNI");
    return Response.json(GENERIC);
  }

  // Don't fan out messages if a fresh code is already outstanding.
  const active = await activePinResetCode(user.id);
  if (active && Date.now() - new Date(active.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    trace(`cooldown activo para ${user.email} (esperá ~60 s)`);
    return Response.json(GENERIC);
  }

  const patient = user.patientId ? await getPatient(user.patientId) : undefined;
  const phone = user.phone?.trim() || patient?.phone?.trim();
  // WhatsApp sends from the number of one of the person's consultorios (the
  // first that configured one); no org with a number → falls back to SMS/email.
  let waFrom: string | undefined;
  if (channel === "whatsapp" && phone && whatsappCredentialsSet()) {
    const orgIds = user.patientId
      ? (await patientOrgs(user.patientId)).map((o) => o.id)
      : (await membershipsForUser(user.id)).map((m) => m.organizationId);
    for (const id of orgIds) {
      waFrom = toE164((await getOrganization(id))?.whatsappFrom);
      if (waFrom) break;
    }
  }
  const useChannel: NotifyChannel =
    waFrom
      ? "whatsapp"
      : channel === "sms" && phone
        ? "sms"
        : "email";
  const to = useChannel === "email" ? user.email : phone;
  if (!to) {
    trace("el paciente no tiene email ni teléfono en la ficha");
    return Response.json(GENERIC);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { hash, salt } = hashCode(code);
  await createPinResetCode({
    userId: user.id,
    codeHash: hash,
    codeSalt: salt,
    channel: useChannel,
    sentTo: useChannel === "email" ? maskEmail(to) : maskPhone(to),
    ttlMinutes: CODE_TTL_MIN,
  });

  await getNotifier().send({
    channel: useChannel,
    to,
    from: waFrom,
    subject: "Código para restablecer tu PIN",
    body:
      `Tu código para restablecer el PIN es ${code}. ` +
      `Vence en ${CODE_TTL_MIN} minutos. Si no lo pediste, ignorá este mensaje.`,
  });

  return Response.json(GENERIC);
}
