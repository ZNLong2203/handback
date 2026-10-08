import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "@/app/shop/sign-in/actions";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig } from "@/lib/paypal/config";
import { SHOP } from "@/lib/shop";
import { staffAccessCode } from "@/lib/staff-access";
import { Logo } from "./brand";
import { cx } from "./ui";

/** Each header lines up with the page under it: the renter's page is narrow, the schedule and dashboard are wide. */
type Width = "max-w-3xl" | "max-w-6xl" | "max-w-[96rem]";

/** Tells anyone trying the demo which parts are real right now. */
export function ModeStrip({ width = "max-w-6xl" }: { width?: "max-w-6xl" | "max-w-[96rem]" }) {
  const paypal = paypalConfig().mode;
  const ai = aiConfigured();
  return (
    <div className="border-b border-line bg-ink text-[12px] text-white/80 sm:text-[13px]">
      <div className={cx("mx-auto flex items-center gap-x-5 px-5 py-1.5", width)}>
        <span className="truncate">
          PayPal:{" "}
          <strong className="text-white">{paypal === "demo" ? "demo stand-in" : paypal === "sandbox" ? "sandbox" : "live"}</strong>
          <span className="hidden sm:inline">{paypal === "demo" ? " (no keys set)" : paypal === "sandbox" ? ", real API calls" : ""}</span>
          <span className="mx-2 text-white/40">·</span>
          AI: <strong className="text-white">{ai ? "Gemini, live" : "recorded replies"}</strong>
          <span className="hidden sm:inline">{ai ? "" : " for sample photos"}</span>
        </span>
        <span className="ml-auto hidden shrink-0 gap-4 sm:flex">
          <Link href="/rent" className="underline-offset-2 hover:underline">
            Customer side
          </Link>
          <Link href="/shop" className="underline-offset-2 hover:underline">
            Counter side
          </Link>
        </span>
      </div>
    </div>
  );
}

export function SiteHeader() {
  return (
    <>
      <ModeStrip />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-1 text-sm font-medium">
          <Link href="/rent" className="rounded-full px-3 py-2 hover:bg-line/50">
            Rent
          </Link>
          <Link href="/shop" className="rounded-full px-3 py-2 hover:bg-line/50">
            For shops
          </Link>
        </nav>
      </header>
    </>
  );
}

export function StoreHeader({ width = "max-w-6xl" }: { width?: Width }) {
  return (
    <>
      <ModeStrip />
      <header className={cx("mx-auto flex items-center justify-between gap-4 px-5 py-5", width)}>
        <Link href="/rent" className="flex min-w-0 flex-col">
          <span className="truncate font-display text-lg font-bold tracking-tight sm:text-xl">{SHOP.name}</span>
          <span className="text-xs text-muted">{SHOP.city} · deposits by Handback</span>
        </Link>
        <Link href="/" className="shrink-0 whitespace-nowrap text-sm text-muted hover:text-ink">
          What is Handback?
        </Link>
      </header>
    </>
  );
}

export function ShopHeader({ live, width = "max-w-6xl" }: { live?: React.ReactNode; width?: Width }) {
  return (
    <>
      <ModeStrip width={width === "max-w-[96rem]" ? width : undefined} />
      <header className="border-b border-line bg-card/70 backdrop-blur">
        <div className={cx("mx-auto flex flex-wrap items-center justify-between gap-x-5 gap-y-1 px-5 py-4", width)}>
          <Logo href="/shop" suffix="Counter" />
          {/* On a phone the links get their own line under the logo. */}
          <nav className="order-last -mx-3 flex w-full items-center gap-1 text-sm font-medium sm:order-none sm:mx-0 sm:mr-auto sm:w-auto" aria-label="Counter">
            <Link href="/shop" className="rounded-full px-3 py-1.5 text-ink-soft hover:bg-line/50 hover:text-ink">
              Rentals
            </Link>
            <Link href="/shop/schedule" className="rounded-full px-3 py-1.5 text-ink-soft hover:bg-line/50 hover:text-ink">
              Schedule
            </Link>
            <Link href="/shop/insights" className="rounded-full px-3 py-1.5 text-ink-soft hover:bg-line/50 hover:text-ink">
              Insights
            </Link>
          </nav>
          <div className="flex items-center gap-4 text-sm">
            {live}
            <span className="hidden text-muted sm:inline">{SHOP.name}</span>
            {staffAccessCode() && (
              <form action={signOutAction}>
                <button type="submit" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-ink-soft hover:bg-line/50 hover:text-ink">
                  <LogOut className="h-4 w-4" aria-hidden /> Sign out
                </button>
              </form>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
