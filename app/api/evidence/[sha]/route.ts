import { getDb } from "@/lib/db/client";
import { packBytes } from "@/lib/disputes/repo";

/**
 * Evidence packs by SHA-256. The bytes behind a hash never change, so the
 * response can be cached; it names the customer, so only privately.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/evidence/[sha]">) {
  const { sha } = await ctx.params;
  const pack = await packBytes(await getDb(), sha);
  if (!pack) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(pack.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pack.rentalId}-evidence.pdf"`,
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${sha}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
