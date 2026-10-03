import { Bot, ShieldCheck } from "lucide-react";
import { after } from "next/server";
import { ShopHeader } from "@/components/headers";
import { LiveRefresh } from "@/components/live-refresh";
import { ScheduleBoard } from "@/components/schedule/schedule-board";
import { Badge, Eyebrow } from "@/components/ui";
import { polishMessages } from "@/lib/schedule/agent";
import { loadScheduleView, prepareSchedule } from "@/lib/schedule/view";
import { requireStaffPage } from "@/lib/staff-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule" };

export default async function SchedulePage() {
  await requireStaffPage("/shop/schedule");
  await prepareSchedule();
  const view = await loadScheduleView();
  if (view.ai && view.pending.some((p) => p.messageSource === "template")) {
    after(() => polishMessages().catch((err) => console.error("message polish failed", err)));
  }

  return (
    <>
      <ShopHeader live={<LiveRefresh channel="shop" />} />
      <main className="mx-auto max-w-[96rem] space-y-6 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Schedule</Eyebrow>
            <h1 className="mt-1 font-display text-4xl font-bold tracking-tight">Who has what, and when</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Every unit on the shelf, by item. When a return is settled with damage or a missing part, the agent takes that unit out for the repair and
              suggests a fix for each booking it touches. You decide.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="brand">
              <Bot className="h-3.5 w-3.5" aria-hidden /> {view.ai ? "Gemini words the customer messages" : "Messages from templates (no AI key or demo mode)"}
            </Badge>
            <Badge tone="released">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Every move is checked on the server
            </Badge>
          </div>
        </div>
        <ScheduleBoard view={view} />
        <p className="text-xs text-muted">
          Timeline by Bryntum Scheduler on its 45-day trial package; the faint &ldquo;Bryntum Trial Version&rdquo; pattern behind the rows is the trial&rsquo;s watermark.
          {view.demo ? " Demo mode: the bookings are sample data booked through the PayPal stand-in." : ""}
        </p>
      </main>
    </>
  );
}
