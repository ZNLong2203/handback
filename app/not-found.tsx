import { ArrowRight, Store } from "lucide-react";
import { SiteHeader } from "@/components/headers";
import { ButtonLink, Card, Eyebrow } from "@/components/ui";

export const metadata = { title: "Not found", robots: { index: false } };

/** Unknown addresses, and rentals or items that do not exist (notFound() in a page). */
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl px-5 pb-16 pt-6">
        <Card className="animate-rise p-6 sm:p-8">
          <Eyebrow>404</Eyebrow>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Nothing is here</h1>
          <p className="mt-2 leading-relaxed text-ink-soft">
            This address does not match a page, an item or a rental. If someone sent you a rental link, check that it is complete: the code at the end
            is long on purpose.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="/rent" variant="brand">
              Rent something <ArrowRight className="h-4 w-4" aria-hidden />
            </ButtonLink>
            <ButtonLink href="/shop" variant="outline">
              <Store className="h-4 w-4" aria-hidden /> Open the counter
            </ButtonLink>
          </div>
        </Card>
      </main>
    </>
  );
}
