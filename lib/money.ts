// Money is handled as integer cents everywhere in the app and converted to
// PayPal's decimal strings only at the API boundary. Floats never touch it.

export type Cents = number;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative whole number of cents, got ${value}`);
  }
  return value;
}

/** 12345 -> "123.45" */
export function toPayPalValue(cents: Cents): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${whole}.${rest.toString().padStart(2, "0")}`;
}

/** "123.45" -> 12345. Rejects anything that is not a plain USD amount. */
export function fromPayPalValue(value: string): Cents {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`not a currency amount: "${value}"`);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(match[1]) * 100 + Number(fraction);
}

/** 12345 -> "$123.45" */
export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${(abs % 100).toString().padStart(2, "0")}`;
}
