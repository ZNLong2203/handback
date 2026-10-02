import { subscribe } from "@/lib/live";

export const dynamic = "force-dynamic";

/**
 * Server-sent events for one rental, or "shop" for all of them. Each message
 * only says that something changed; the page re-renders from the database,
 * so nothing sensitive travels on this stream.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/live/[channel]">) {
  const { channel } = await ctx.params;
  if (channel !== "shop" && !/^R-[0-9A-Z]{6}$/.test(channel)) {
    return new Response("Not found", { status: 404 });
  }
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("ready", { channel });
      const unsubscribe = subscribe(channel, (e) => send("update", { type: e.type, at: e.at }));
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
