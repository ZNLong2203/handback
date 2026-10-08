import { Bot, KeyRound, ShieldCheck } from "lucide-react";
import { ShopHeader } from "@/components/headers";
import { InsightsBoard } from "@/components/insights/insights-board";
import { Badge, Eyebrow } from "@/components/ui";
import { agentRefusal, scriptedAgent } from "@/lib/insights/llm";
import { loadInsights } from "@/lib/insights/load";
import { seedInsightsHistoryOnce } from "@/lib/insights/seed";
import { studioData } from "@/lib/insights/studio-data";
import { paypalConfig } from "@/lib/paypal/config";
import { clientAddress, requireStaffPage } from "@/lib/staff-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

export default async function InsightsPage() {
  await requireStaffPage("/shop/insights");
  const demo = paypalConfig().mode === "demo";
  if (demo) await seedInsightsHistoryOnce();
  const now = new Date();
  const data = await loadInsights(now);
  const spec = studioData(data);
  // The agent needs a Gemini key, and an access code on a counter others can reach (lib/insights/llm.ts).
  const agentOff = agentRefusal(await clientAddress());
  const ai = agentOff === null;
  // A front-end licence key reaches the browser by design; it is set on the host, never in the repository.
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || null;

  return (
    <>
      <ShopHeader width="max-w-[96rem]" />
      <main className="mx-auto max-w-[96rem] space-y-5 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Insights</Eyebrow>
            <h1 className="mt-1 font-display text-4xl font-bold tracking-tight">Where the deposit money went</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Every PayPal movement the counter recorded: what was held, what was kept and for which repair, what went back, and which holds need you now.
              Click a band or a bar to filter the page.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={ai ? "brand" : "neutral"}>
              <Bot className="h-3.5 w-3.5" aria-hidden /> {ai ? (scriptedAgent() ? "Deposit desk agent on a test script" : "Deposit desk agent on Gemini") : agentOff.includes("GEMINI_API_KEY") ? "AI assistant needs a Gemini key" : "AI assistant needs an access code"}
            </Badge>
            <Badge tone="released">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> The agent can draft a refund, never send one
            </Badge>
          </div>
        </div>
        <InsightsBoard spec={spec} month={now.toISOString().slice(0, 7)} licenseKey={licenseKey} ai={ai} />
        <div className="space-y-1 text-xs text-muted">
          {agentOff && <p>{agentOff}</p>}
          <p className="flex items-start gap-1.5">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Dashboard by AG Studio, a commercial component.{" "}
              {licenseKey
                ? "Licensed with the key set on this server."
                : "No licence key is set on this server, so AG Studio runs as a trial: it shows a “For Trial Use Only” watermark (not on localhost) and logs a licence notice in the browser console."}{" "}
              The two custom widgets draw their own SVG; they use no AG Grid or AG Charts package of their own.
            </span>
          </p>
          {demo && <p>Demo mode: the history is sample rentals booked through the PayPal stand-in, then moved back in time; their audit trails keep the real times.</p>}
        </div>
      </main>
    </>
  );
}
