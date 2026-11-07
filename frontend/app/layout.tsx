import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { RevealRoot } from "@/components/Reveal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/components/Wallet";
import { PrivyBridge } from "@/components/PrivyBridge";
import { cn } from "@/lib/utils";
import "./globals.css";

/** Geist for UI and money, Bricolage Grotesque for display titles, JetBrains Mono for micro labels and hashes. */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const serif = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face" });

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
