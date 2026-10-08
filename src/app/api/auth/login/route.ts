import { getUserByDni, getUserByEmail, membershipsForUser } from "@/lib/db/repo";
import { verifyPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";

/**
 * Unified login: (email or DNI) + PIN. Email works for every role; DNI resolves
 * to the patient portal login behind that ficha. Staff with more than one
 * organization and no `organizationId` get `{ needsOrg: true, organizations }`
 * so the client can ask which one to enter.
 */
export async function POST(req: Request) {
  const { identifier, email, dni, pin, organizationId } = (await req.json()) as {
    identifier?: string;
    email?: string;
    dni?: string;
    pin?: string;
    organizationId?: string;
  };

  const raw = (identifier ?? email ?? dni ?? "").trim();
  if (!raw || !pin) {
    return Response.json({ ok: false, error: "Ingresá tu email o DNI y tu PIN." }, { status: 400 });
  }

  const user = raw.includes("@") ? await getUserByEmail(raw) : await getUserByDni(raw);
  if (!user || !verifyPin(pin, user.pinHash, user.pinSalt)) {
    return Response.json({ ok: false, error: "Datos o PIN incorrectos." }, { status: 401 });
  }

  const claims: SessionClaims = { userId: user.id, role: user.role, patientId: user.patientId };

  if (user.role !== "paciente") {
    const mems = await membershipsForUser(user.id);
    if (mems.length === 0) {
      return Response.json(
        { ok: false, error: "Ese usuario no está en ninguna organización." },
        { status: 403 },
      );
    }
    if (mems.length > 1 && !organizationId) {
      return Response.json({
        ok: true,
        needsOrg: true,
        organizations: mems.map((m) => ({ id: m.organizationId, name: m.organizationName, role: m.role })),
      });
    }
    const chosen = organizationId
      ? mems.find((m) => m.organizationId === organizationId)
      : mems[0];
    if (!chosen) {
      return Response.json(
        { ok: false, error: "Ese usuario no trabaja en el consultorio elegido." },
        { status: 403 },
      );
    }
    claims.activeOrgId = chosen.organizationId;
    claims.role = chosen.role;
  }

  const actor = await hydrateActor(claims);
  return Response.json(
    { ok: true, actor },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
