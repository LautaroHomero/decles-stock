import { actorFromRequest } from "@/lib/auth/actor";

export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ actor: null }, { status: 401 });
  return Response.json({ actor });
}
