import { readFile } from "node:fs/promises";
import { sampleFile } from "@/lib/samples";

/** Serves the bundled AI-generated sample photos (lib/samples.ts) for the storefront and the demo. */
export async function GET(_req: Request, ctx: RouteContext<"/api/samples/[...key]">) {
  const file = sampleFile((await ctx.params).key.join("/"));
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
