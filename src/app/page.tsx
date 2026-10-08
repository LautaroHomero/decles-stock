import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { hydrateActor } from "@/lib/auth/actor";
import { StockApp } from "./stock-app";

export default async function Page() {
  const store = await cookies();
  const actor = await hydrateActor(verifySession(store.get(SESSION_COOKIE)?.value));
  if (!actor || actor.role === "paciente") redirect("/login");
  return <StockApp actor={actor} />;
}
