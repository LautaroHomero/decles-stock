import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { hydrateActor } from "@/lib/auth/actor";
import { needsSetup } from "@/lib/domain/accounts";
import { StockApp } from "./stock-app";
import { ForcedPasswordChange } from "./forced-password";

export default async function Page() {
  // Leer las cookies primero hace la página dinámica: nunca se arma en el build (no hay base ahí).
  const store = await cookies();
  if (await needsSetup()) redirect("/setup");
  const actor = await hydrateActor(verifySession(store.get(SESSION_COOKIE)?.value));
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) return <ForcedPasswordChange name={actor.name} />;
  return <StockApp actor={actor} />;
}
