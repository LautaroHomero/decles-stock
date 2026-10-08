import {
  activePinResetCode,
  bumpPinResetAttempts,
  consumePinResetCode,
  findLogin,
  updateUserPin,
} from "@/lib/db/repo";
import { hashPin, verifyPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";

/**
 * Step 2 of PIN recovery: exchange the one-time code for a new PIN.
 * A patient is logged in straight away (they proved control of the registered
 * channel); staff are asked to sign in (they may need to pick an organization).
 */
const MAX_ATTEMPTS = 5;

export async function POST(req: Request) {
  const { email, dni, code, newPin } = (await req.json().catch(() => ({}))) as {
    email?: string;
    dni?: string;
    code?: string;
    newPin?: string;
  };
  if ((!email?.trim() && !dni?.trim()) || !code?.trim() || !newPin?.trim()) {
    return Response.json({ ok: false, error: "Faltan datos." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(newPin)) {
    return Response.json({ ok: false, error: "El PIN nuevo tiene que ser de 4 dígitos." }, { status: 400 });
  }

  const user = await findLogin({ email: email?.trim(), dni: dni?.trim() });
  const active = user ? await activePinResetCode(user.id) : undefined;
  if (!user || !active) {
    return Response.json(
      { ok: false, error: "Código inválido o vencido. Pedí uno nuevo." },
      { status: 400 },
    );
  }

  if (active.attempts >= MAX_ATTEMPTS) {
    await consumePinResetCode(active.id);
    return Response.json(
      { ok: false, error: "Demasiados intentos. Pedí un código nuevo." },
      { status: 429 },
    );
  }

  if (!verifyPin(code.trim(), active.codeHash, active.codeSalt)) {
    const n = await bumpPinResetAttempts(active.id);
    if (n >= MAX_ATTEMPTS) await consumePinResetCode(active.id);
    return Response.json({ ok: false, error: "Código incorrecto." }, { status: 400 });
  }

  await updateUserPin(user.id, hashPin(newPin));
  await consumePinResetCode(active.id);

  // Staff may belong to several orgs → let the normal login pick one.
  if (user.role !== "paciente") {
    return Response.json({
      ok: true,
      staff: true,
      message: "PIN actualizado. Iniciá sesión con tu DNI o email y tu PIN nuevo.",
    });
  }

  const claims: SessionClaims = { userId: user.id, role: "paciente", patientId: user.patientId };
  return Response.json(
    { ok: true, actor: await hydrateActor(claims) },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
