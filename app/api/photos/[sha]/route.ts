import { loadPhoto } from "@/lib/photos";

/** Photos are content-addressed, so a URL's bytes never change and can be cached forever. */
export async function GET(_req: Request, ctx: RouteContext<"/api/photos/[sha]">) {
  const { sha } = await ctx.params;
  const photo = await loadPhoto(sha);
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${sha}"`,
    },
  });
}
