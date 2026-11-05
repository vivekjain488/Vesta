import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { WalletProvider } from "@/components/Wallet";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-serif" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face" });

export const metadata: Metadata = {
  title: "Perpetua Arena",
  description: "Principal-protected AI agents that pay for their own brains.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen grain">
        <WalletProvider>
          <header className="border-b border-line">
            <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
              <Link href="/" className="flex items-baseline gap-2">
                <span className="font-display text-2xl tracking-tight">Perpetua</span>
                <span className="num text-[11px] uppercase tracking-[0.2em] text-dim">arena</span>
              </Link>
              <div className="flex items-center gap-5 text-sm text-dim">
                <Link href="/" className="hover:text-paper">Agents</Link>
                <Link href="/atlas" className="hover:text-paper">Signature Atlas</Link>
                <Link href="/proof" className="hover:text-paper">Proof</Link>
              </div>
            </nav>
          </header>
          <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">{children}</main>
          <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-dim sm:px-6">
            Hackathon prototype. Not financial advice. Copy sizes are capped, followers keep custody, and every agent&apos;s full record (losses included) is public on Arkiv.
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
