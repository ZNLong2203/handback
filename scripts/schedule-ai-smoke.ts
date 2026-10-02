// Runs the schedule's two Gemini jobs once against the real API, with the
// same prompts, tool schemas and checks the app uses, and no database:
// wording a customer message, and reading two typed commands.
// Run: npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/schedule-ai-smoke.ts
import { addDaysIso, todayIso } from "@/lib/dates";
import { COMMAND_TOOLS, commandPrompt, toCommandCall, type CommandContext } from "@/lib/schedule/commands";
import { callOneTool, scheduleModel } from "@/lib/schedule/gemini";
import { checkMessage, draftMessage, type MessageFacts } from "@/lib/schedule/messages";

if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in .env.local first");
// The app never calls Gemini in demo mode; this script is the one place that does on purpose.
delete process.env.DEMO_MODE;

const today = todayIso();
const day = (n: number) => addDaysIso(today, n);

const facts: MessageFacts = {
  shopName: "Kestrel Camera Rentals",
  customerName: "Diego Alvarez",
  itemName: "Portable projector",
  kind: "reschedule",
  why: "repair",
  booked: { start: day(5), end: day(7) },
  offered: { start: day(6), end: day(8) },
};

const ctx: CommandContext = {
  today,
  units: [
    { id: "drone-kit-a", itemId: "drone-kit", label: "Drone kit A", position: 1, itemName: "Folding camera drone kit" },
    { id: "drone-kit-b", itemId: "drone-kit", label: "Drone kit B", position: 2, itemName: "Folding camera drone kit" },
    { id: "projector-a", itemId: "projector", label: "Projector A", position: 1, itemName: "Portable projector" },
    { id: "projector-b", itemId: "projector", label: "Projector B", position: 2, itemName: "Portable projector" },
  ],
  bookings: [
    { id: "R-MAYA01", customerName: "Maya Chen", itemId: "drone-kit", unitId: "drone-kit-a", startDate: day(3), endDate: day(6) },
    { id: "R-PRIY01", customerName: "Priya Patel", itemId: "projector", unitId: "projector-a", startDate: day(2), endDate: day(4) },
  ],
};

async function main() {
  console.log(`model ${scheduleModel()}, today ${today}`);

  let started = Date.now();
  const drafted = await draftMessage(facts);
  console.log(`\nmessage (${drafted.source}, ${Date.now() - started} ms):\n  ${drafted.text}`);
  console.log(`  checks: ${checkMessage(drafted.text, facts) ?? "pass"}`);

  for (const command of ["move Maya's drone booking to the other unit", "block projector B for 2 days from tomorrow for a lens clean"]) {
    started = Date.now();
    const raw = await callOneTool(commandPrompt(command, ctx), COMMAND_TOOLS);
    const call = toCommandCall(raw);
    console.log(`\n"${command}" (${Date.now() - started} ms)`);
    console.log(`  raw:     ${JSON.stringify(raw)}`);
    console.log(`  checked: ${call ? `${call.tool} ${JSON.stringify(call.args)}` : "rejected by the schema"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
