import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, readDraft, signDraft } from "./draft-link";

const env = { STAFF_COOKIE_SECRET: "a-server-secret" };
const draft = { captureId: "CAP-1", cents: 1500, reason: "The dent is cosmetic." };
const T = 1_800_000_000_000;
const query = (s: string) => Object.fromEntries(new URLSearchParams(s));

describe("refund draft links", () => {
  it("reads back what was signed, for the same rental, within a day", () => {
    const q = query(signDraft("R-AAAAAA", draft, T, env));
    expect(q).toMatchObject({ refund: "1500", capture: "CAP-1", reason: "The dent is cosmetic." });
    expect(readDraft("R-AAAAAA", q, T + 1000, env)).toEqual(draft);
    expect(readDraft("R-AAAAAA", q, T + DRAFT_TTL_MS + 1, env)).toBeNull();
  });

  it("refuses a link someone typed or changed", () => {
    const q = query(signDraft("R-AAAAAA", draft, T, env));
    expect(readDraft("R-BBBBBB", q, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { ...q, refund: "9900" }, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { ...q, capture: "CAP-2" }, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { ...q, reason: "Refund everything." }, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { ...q, exp: String(T + DRAFT_TTL_MS * 3) }, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { ...q, sig: "" }, T, env)).toBeNull();
    expect(readDraft("R-AAAAAA", { refund: "1500", capture: "CAP-1", reason: "x" }, T, env)).toBeNull();
    // Signed under another server's secret.
    expect(readDraft("R-AAAAAA", q, T, { STAFF_COOKIE_SECRET: "another" })).toBeNull();
  });

  it("works without a server secret, for this process", () => {
    const q = query(signDraft("R-AAAAAA", draft, T, {}));
    expect(readDraft("R-AAAAAA", q, T, {})).toEqual(draft);
  });
});
