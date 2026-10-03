"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import type { ActionResult } from "@/app/actions";
import { polishMessages } from "@/lib/schedule/agent";
import { interpretCommand } from "@/lib/schedule/commands";
import * as schedule from "@/lib/schedule/service";
import { UserError } from "@/lib/rentals/types";
import { requireStaff } from "@/lib/staff-access";

/**
 * Same contract as the counter's actions: errors come back as text people can
 * act on, and the staff check runs first (every schedule action is staff-only).
 */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireStaff();
    const data = await fn();
    refresh();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: "Something went wrong on our side. Nothing was changed; please try again." };
  }
}

/** Gemini rewords new customer messages once the response is out; the template stays if it fails the checks. */
const polishLater = () => after(() => polishMessages().catch((err) => console.error("message polish failed", err)));

/** A drag on the timeline. The browser only says which booking and which unit; the server checks the rest. */
export async function moveRentalAction(rentalId: string, unitId: string) {
  return run(async () => {
    const result = await schedule.moveRentalToUnit(rentalId, unitId);
    polishLater();
    return result;
  });
}

export async function approveProposalAction(proposalId: string) {
  return run(async () => {
    await schedule.approveProposal(proposalId);
    polishLater();
  });
}

export async function rejectProposalAction(proposalId: string, note?: string) {
  return run(() => schedule.rejectProposal(proposalId, note));
}

export type CommandReply = { via: "gemini" | "parser"; kind: "proposal" | "question" | "refused"; proposalId: string | null; text: string };

/** A typed command: at most one pending proposal comes out of it, never a change. */
export async function commandAction(text: string) {
  return run<CommandReply>(async () => {
    const outcome = await interpretCommand(String(text ?? ""));
    if (!outcome.ok) return { via: outcome.via, kind: outcome.question ? "question" : "refused", proposalId: null, text: outcome.message };
    return { via: outcome.via, kind: "proposal", proposalId: outcome.proposal.id, text: outcome.proposal.summary };
  });
}
