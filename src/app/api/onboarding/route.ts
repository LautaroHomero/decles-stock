import { dismissOnboarding, onboardingStatus } from "@/lib/domain/onboarding";
import { actorOr401, bodyOf, respond } from "../_http";

/** Estado de "Primeros pasos" (admin). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await onboardingStatus(actor));
}

/** Ocultar (`{ done: true }`) o volver a mostrar (`{ done: false }`). */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ done: boolean }>(req);
  return respond(await dismissOnboarding(actor, b.done !== false));
}
