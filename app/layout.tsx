import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], weight: ["500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: { default: "Handback: rental deposits that settle themselves, fairly", template: "%s · Handback" },
  description:
    "PayPal holds the deposit at pickup. AI compares the pickup and return photos. The customer sees every charge before it is taken, and the rest is released on PayPal right away.",
};

export const viewport: Viewport = {
  themeColor: "#faf7f2",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${bricolage.variable} h-full`}>
      <body className="min-h-full bg-paper text-ink">{children}</body>
    </html>
  );
}
