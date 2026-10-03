import Link from "next/link";
import { redirect } from "next/navigation";
import { ModeStrip } from "@/components/headers";
import { Logo } from "@/components/brand";
import { StaffSignIn } from "@/components/staff-sign-in";
import { Card, Eyebrow } from "@/components/ui";
import { isPublicDemo, isStaff, safeNext, staffAccessCode } from "@/lib/staff-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Counter sign-in", robots: { index: false } };

/** Only exists when SHOP_ACCESS_CODE is set; otherwise the counter is open and this page sends you there. */
export default async function StaffSignInPage(props: PageProps<"/shop/sign-in">) {
  const { next: raw } = await props.searchParams;
  const next = safeNext(typeof raw === "string" ? raw : null);
  if (!staffAccessCode() || (await isStaff())) redirect(next);

  return (
    <>
      <ModeStrip />
      <header className="mx-auto flex max-w-6xl items-center px-5 py-5">
        <Logo href="/" suffix="Counter" />
      </header>
      <main className="mx-auto max-w-md px-5 pb-16">
        <Card className="animate-rise p-6">
          <Eyebrow>Counter</Eyebrow>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Staff sign-in</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {isPublicDemo()
              ? "Staff only. The code is in the Devpost testing instructions."
              : "Staff only. Ask the shop for the counter's access code."}
          </p>
          <StaffSignIn next={next} />
          <p className="mt-5 text-xs leading-relaxed text-muted">
            The code is shared by the shop&apos;s staff; it opens the counter on this device for 12 hours. Renting something?{" "}
            <Link href="/rent" className="font-medium text-ink underline underline-offset-2">
              Go to the customer side
            </Link>
            .
          </p>
        </Card>
      </main>
    </>
  );
}
