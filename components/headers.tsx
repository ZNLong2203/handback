import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "@/app/shop/sign-in/actions";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig } from "@/lib/paypal/config";
import { SHOP } from "@/lib/shop";
import { staffAccessCode } from "@/lib/staff-access";
import { Logo } from "./brand";

/** Tells anyone trying the demo which parts are real right now. */
export function ModeStrip() {
  const paypal = paypalConfig().mode;
  const ai = aiConfigured();
  return (
    <div className="border-b border-line bg-ink text-[12px] text-white/80 sm:text-[13px]">
      <div className="mx-auto flex max-w-6xl items-center gap-x-5 px-5 py-1.5">
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

export function StoreHeader() {
  return (
    <>
      <ModeStrip />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link href="/rent" className="flex flex-col">
          <span className="font-display text-xl font-bold tracking-tight">{SHOP.name}</span>
          <span className="text-xs text-muted">{SHOP.city} · deposits by Handback</span>
        </Link>
        <Link href="/" className="text-sm text-muted hover:text-ink">
          What is Handback?
        </Link>
      </header>
    </>
  );
}

export function ShopHeader({ live }: { live?: React.ReactNode }) {
  return (
    <>
      <ModeStrip />
      <header className="border-b border-line bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-5 gap-y-1 px-5 py-4">
          <Logo href="/shop" suffix="Counter" />
          {/* On a phone the links get their own line under the logo. */}
          <nav className="order-last -mx-3 flex w-full items-center gap-1 text-sm font-medium sm:order-none sm:mx-0 sm:mr-auto sm:w-auto" aria-label="Counter">
            <Link href="/shop" className="rounded-full px-3 py-1.5 text-ink-soft hover:bg-line/50 hover:text-ink">
              Rentals
            </Link>
            <Link href="/shop/schedule" className="rounded-full px-3 py-1.5 text-ink-soft hover:bg-line/50 hover:text-ink">
              Schedule
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
