import { connection } from "next/server";
import { recoveryEnabled, requestPasswordReset } from "@/lib/domain/accounts";
import { bodyOf, respond } from "../../_http";

/** ¿Está activa la recuperación por email? (si no hay SMTP en producción, no). */
export async function GET() {
  await connection(); // siempre en el momento (nunca armado en el build)
  return Response.json({ ok: true, enabled: recoveryEnabled() });
}

/** `{ identifier }` (usuario o email) → manda un código de 6 dígitos. Responde igual exista o no. */
export async function POST(req: Request) {
  const b = await bodyOf<{ identifier: string }>(req);
  return respond(await requestPasswordReset(b.identifier ?? ""));
}
