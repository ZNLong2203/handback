import Link from "next/link";
import { StoreHeader } from "@/components/headers";
import { Badge, Eyebrow } from "@/components/ui";
import { CATALOG } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";

export const metadata = { title: "Rent" };

const SAMPLE: Record<string, string> = { ebike: "ebike-rear" };

export default function Storefront() {
  return (
    <>
      <StoreHeader />
      <main className="mx-auto max-w-6xl px-5 pb-16">
        <Eyebrow>Rent by the day</Eyebrow>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight">Cameras, drones and gear for the weekend</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Pay the rental fee now. The deposit is only held at pickup, and you see every proposed charge before anything is taken from it.
        </p>
        <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {CATALOG.map((item) => (
            <li key={item.id}>
              <Link href={`/rent/${item.id}`} className="group block overflow-hidden rounded-[var(--radius-card)] border border-line bg-card shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/samples/${SAMPLE[item.id] ?? item.id}/before`} alt="" className="aspect-[4/3] w-full object-cover" />
                <div className="p-4">
                  <Badge>{item.category}</Badge>
                  <p className="mt-2 font-semibold leading-snug group-hover:underline">{item.name}</p>
                  <p className="mt-1 text-sm">
                    <span className="tabular font-semibold">{formatUsd(item.dailyCents)}</span>
                    <span className="text-muted"> / day</span>
                  </p>
                  <p className="text-xs text-held">{formatUsd(item.depositCents)} deposit, held at pickup</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-center text-xs text-muted">Product photos are AI-generated for the demo.</p>
      </main>
    </>
  );
}
