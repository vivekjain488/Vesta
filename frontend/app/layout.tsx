import type { Metadata } from "next";
import localFont from "next/font/local";
import { AppShell } from "@/components/AppShell";
import { RevealRoot } from "@/components/Reveal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/components/Wallet";
import { PrivyBridge } from "@/components/PrivyBridge";
import { cn } from "@/lib/utils";
import "./globals.css";

/** Geist for UI and money, Bricolage Grotesque for display titles, JetBrains Mono for micro labels and hashes. */
const geist = localFont({ src: "./fonts/geist.ttf", weight: "100 900", variable: "--font-geist", display: "swap" });
const serif = localFont({ src: "./fonts/bricolage-grotesque.ttf", weight: "200 800", variable: "--font-serif", display: "swap" });
const mono = localFont({ src: "./fonts/jetbrains-mono.ttf", weight: "100 800", variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  title: "VESTA",
  description: "VESTA: Vault-Endowed Self-funding Trading Agents. Manage your agents and investments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(geist.variable, serif.variable, mono.variable)}>
      <body className="canvas-grid min-h-screen">
        <PrivyBridge><WalletProvider>
          <TooltipProvider delayDuration={150}>
            <RevealRoot>
              <AppShell>{children}</AppShell>
            </RevealRoot>
          </TooltipProvider>
        </WalletProvider></PrivyBridge>
      </body>
    </html>
  );
}
