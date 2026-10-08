import { ArrowRight, Camera, CreditCard, Eye, FileCheck2, Scale, ShieldCheck, Store, Users } from "lucide-react";
import { SiteHeader } from "@/components/headers";
import { MoneyBar } from "@/components/money-bar";
import { ButtonLink, Card, Eyebrow } from "@/components/ui";
import headline from "@/eval/headline.json";

const steps = [
  {
    icon: CreditCard,
    title: "Book",
    body: "The customer pays the rental fee with PayPal and, in the same approval, lets the shop hold a deposit later. No deposit is taken yet.",
  },
  {
    icon: Camera,
    title: "Pick up",
    body: "Staff photograph the item and tap once: PayPal holds the deposit on the saved wallet. Its 29-day clock starts when the item leaves.",
  },
  {
    icon: Eye,
    title: "Return",
    body: "Staff photograph it again. Two independent AI looks compare the photos; people decide; PayPal keeps only the agreed charge and releases the rest.",
  },
];

const fairness = [
  { icon: Users, title: "Two looks must agree", body: "Two separate model calls compare the photos. A charge is proposed only when both see the same thing." },
  { icon: Scale, title: "Prices come from your list", body: "The AI points at an entry in the shop's repair price list. It never names an amount." },
  { icon: ShieldCheck, title: "The customer co-signs", body: "Every proposed charge goes to the customer's phone first. They accept it or question it, in their own words." },
  { icon: FileCheck2, title: "Evidence, not vibes", body: "Photos are stored under their SHA-256 hash, and every step is hash-chained with its PayPal ids." },
];

const SET_NAMES: Record<string, string> = { synthetic: "AI-generated pairs", real: "pairs built on real photos" };

/** Two looks with the prompt the app sends, written from the saved eval runs by `npm run eval:summary`. */
const measured = headline.sets.map((s) => ({
  set: `${s.pairs} ${SET_NAMES[s.id]}, ${s.runs} runs`,
  caught: `${s.changesCharged}/${s.changes}`,
  charged: `${s.unchangedCharged}/${s.unchanged}`,
}));

const paypal = [
  "Orders v2: fee capture with vault, deposit AUTHORIZE",
  "Vault v3: merchant-initiated holds and charges",
  "Payments v2: final partial capture, void, reauthorize",
  "Disputes v1: evidence pack from the rental's own record",
  "JS SDK v6: PayPal button with savePayment",
  "PayPal-Request-Id on every POST; debug_id in the audit log",
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-8 lg:grid-cols-[1.05fr_1fr]">
          <div className="animate-rise">
            <Eyebrow>For rental shops that take deposits on PayPal</Eyebrow>
            <h1 className="mt-4 font-display text-5xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl">
              Deposits that settle themselves, <span className="text-released">fairly.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
              PayPal holds the deposit when the item leaves. When it comes back, AI compares the pickup and return photos, the customer sees every
              proposed charge on their own phone, and the rest is released on PayPal right away.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/rent" size="lg" variant="brand">
                Rent something <ArrowRight className="h-5 w-5" aria-hidden />
              </ButtonLink>
              <ButtonLink href="/shop" size="lg" variant="outline">
                <Store className="h-5 w-5" aria-hidden /> Open the counter
              </ButtonLink>
            </div>
            <p className="mt-4 text-sm text-muted">Try both sides: book as a customer in one tab, run the counter in another.</p>
          </div>

          <Card className="animate-rise overflow-hidden p-4 [animation-delay:120ms]">
            {/* The demo story: a city bike back without its phone holder and rear light. The photos keep their own
                1280x956 shape, so the boxes, where the recorded Gemini looks placed the two parts, land on them. */}
            <div className="grid grid-cols-2 gap-3">
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/api/samples/city-bike/before"
                  alt="City bike at pickup, with a phone holder on the handlebar and a rear light under the saddle"
                  className="aspect-[1280/956] w-full rounded-xl object-cover"
                />
                <figcaption className="mt-1.5 text-xs font-medium text-muted">At pickup</figcaption>
              </figure>
              <figure>
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/api/samples/city-bike/after__missing-holder-rear-light"
                    alt="City bike at return, the phone holder and the rear light gone"
                    className="aspect-[1280/956] w-full rounded-xl object-cover"
                  />
                  <span className="absolute left-[41.5%] top-[10.5%] h-[16%] w-[9%] rounded-[3px] border-2 border-dashed border-charged" aria-hidden />
                  <span className="absolute left-[63.5%] top-[33%] h-[8.5%] w-[7.5%] rounded-[3px] border-2 border-dashed border-note" aria-hidden />
                </div>
                <figcaption className="mt-1.5 text-xs font-medium text-muted">At return: phone holder and rear light missing</figcaption>
              </figure>
            </div>
            <div className="mt-4 rounded-2xl bg-paper p-4">
              <p className="text-sm font-semibold">$150 deposit, settled in one tap</p>
              <p className="mb-3 mt-0.5 text-xs text-muted">The renter accepted the $12 phone holder and questioned the rear light, which the counter waived.</p>
              <MoneyBar state="settled" authorizedCents={15000} capturedCents={1200} releasedCents={13800} size="lg" />
            </div>
            <p className="mt-3 text-center text-[11px] text-muted">Sample photos are AI-generated for the demo.</p>
          </Card>
        </section>

        <section className="border-y border-line bg-card/60">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <Eyebrow>How it works</Eyebrow>
            <div className="mt-6 grid gap-5 md:grid-cols-3">
              {steps.map((s, i) => (
                <div key={s.title} className="rounded-2xl border border-line bg-card p-6">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-soft text-brand">
                      <s.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="font-display text-2xl font-bold">
                      {i + 1}. {s.title}
                    </span>
                  </div>
                  <p className="mt-3 leading-relaxed text-ink-soft">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <Eyebrow>Why customers can trust it</Eyebrow>
              <h2 className="mt-3 font-display text-4xl font-bold tracking-tight">AI finds. People decide. The customer sees it first.</h2>
              <p className="mt-4 leading-relaxed text-ink-soft">
                Automated damage scanners have charged renters for scratches that were never there. Handback is built the other way round: the model
                can only propose, uncertain findings are never charged, and nothing moves until the person paying has seen the evidence.
              </p>
              <div className="mt-6 rounded-2xl border border-line bg-card p-5">
                <p className="text-sm font-semibold">Measured on labeled photo pairs</p>
                {measured.map((m) => (
                  <div key={m.set} className="mt-4 border-t border-line pt-3 first-of-type:border-t-0 first-of-type:pt-0">
                    <p className="text-xs font-semibold text-ink-soft">{m.set}</p>
                    <dl className="mt-1 grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-xs text-muted">Real changes caught</dt>
                        <dd className="font-display text-3xl font-bold">{m.caught}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Unchanged items charged</dt>
                        <dd className="font-display text-3xl font-bold text-released">{m.charged}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
                <p className="mt-3 text-xs text-muted">
                  The real-photo pairs start from freely licensed photos, but the damage in them is still drawn by an image model. Details in
                  eval/README.md.
                </p>
              </div>
            </div>
            <div className="grid content-start gap-4 sm:grid-cols-2">
              {fairness.map((f) => (
                <div key={f.title} className="rounded-2xl border border-line bg-card p-5">
                  <f.icon className="h-6 w-6 text-released" aria-hidden />
                  <p className="mt-3 font-semibold">{f.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-soft">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line bg-ink text-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 md:grid-cols-2">
            <div>
              <Eyebrow className="text-white/60">Built on PayPal</Eyebrow>
              <h2 className="mt-3 font-display text-3xl font-bold">One approval at booking. Every later step needs no buyer present.</h2>
              <p className="mt-3 leading-relaxed text-white/70">
                PayPal releases the unused part of the hold the moment the shop settles, so the customer sees it in their PayPal activity while still at
                the counter. (When the wallet is funded by a card, the card issuer decides when its pending line disappears.)
              </p>
            </div>
            <ul className="space-y-2.5 self-center">
              {paypal.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-white/85">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#7fd0a6]" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <footer className="mx-auto max-w-6xl px-5 py-8 text-sm text-muted">
        Handback is a hackathon project. Kestrel Rentals is a fictional demo shop. Open source under the MIT license.
      </footer>
    </>
  );
}
