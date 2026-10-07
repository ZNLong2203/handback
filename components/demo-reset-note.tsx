import { RotateCcw } from "lucide-react";
import { demoResetConfig, resetReseeds, resetTimeLabel } from "@/lib/demo-reset/config";
import { paypalConfig } from "@/lib/paypal/config";

/**
 * One line saying the public demo starts over every day, shown only when
 * DEMO_RESET is on (and not refused), so a judge who comes back tomorrow is
 * not surprised that yesterday's rental is gone.
 */
export function DemoResetNote({ audience, className = "" }: { audience: "counter" | "renter"; className?: string }) {
  const config = demoResetConfig();
  if (!config.enabled || config.refusal) return null;
  const mode = paypalConfig().mode;
  const when = resetTimeLabel(config.hourUtc, new Date());
  const schedule = `This demo starts over every day at ${when.utc} (${when.pacific}), ${when.until}.`;
  const what =
    audience === "counter"
      ? `Every rental is deleted then${resetReseeds(mode) ? " and the sample rentals are booked again" : ""}${mode === "sandbox" ? "; deposits still held on PayPal are released" : ""}.`
      : `Bookings made here are deleted then${mode === "sandbox" ? ", and a deposit still held on PayPal is released" : ""}.`;
  return (
    <p className={`flex items-start gap-2 text-xs text-muted ${className}`} data-testid="demo-reset-note">
      <RotateCcw className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {schedule} {what}
      </span>
    </p>
  );
}
