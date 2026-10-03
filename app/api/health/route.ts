import { checkHealth } from "@/lib/health";
import { clientAddressFrom } from "@/lib/staff-access";

export const dynamic = "force-dynamic";

/**
 * Render's HTTP health check (healthCheckPath in render.yaml): 200 when the
 * database answers, 503 when it does not, so a new deploy only goes live once
 * it can reach Postgres. The body says which modes this deployment runs in.
 */
export async function GET(req: Request) {
  const health = await checkHealth();
  // The caller's own address as the sign-in limiter sees it, to check TRUSTED_PROXY_HOPS after deploying.
  const body = { ...health, staffAccess: { ...health.staffAccess, countedAs: clientAddressFrom(req.headers) } };
  return Response.json(body, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
