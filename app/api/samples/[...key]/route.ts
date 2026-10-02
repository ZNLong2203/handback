import { readFile } from "node:fs/promises";
import path from "node:path";

const KEY = /^[a-z0-9-]+\/[a-z0-9_-]+$/;

/** Serves the bundled AI-generated sample photos (eval/images) for the storefront and the demo. */
export async function GET(_req: Request, ctx: RouteContext<"/api/samples/[...key]">) {
  const key = (await ctx.params).key.join("/");
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(process.cwd(), "eval", "images", `${key}.jpg`));
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
