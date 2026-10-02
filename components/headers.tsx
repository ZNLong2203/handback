import Link from "next/link";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig } from "@/lib/paypal/config";
import { SHOP } from "@/lib/shop";
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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <Logo href="/shop" suffix="Counter" />
          <div className="flex items-center gap-4 text-sm">
            {live}
            <span className="hidden text-muted sm:inline">{SHOP.name}</span>
          </div>
        </div>
      </header>
    </>
  );
}
