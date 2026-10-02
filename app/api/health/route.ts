import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Render's HTTP health check (healthCheckPath in render.yaml): 200 when the
 * database answers, 503 when it does not, so a new deploy only goes live once
 * it can reach Postgres. The body says which modes this deployment runs in.
 */
export async function GET() {
  const health = await checkHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
