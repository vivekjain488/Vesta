import type { Metadata } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/components/Wallet";
import { cn } from "@/lib/utils";
import "./globals.css";

/** Geist for UI and money, Instrument Serif for display titles, JetBrains Mono for micro labels and hashes. */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-serif" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face" });

export const metadata: Metadata = {
  title: "Perpetua",
  description: "Manage your agents and investments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(geist.variable, serif.variable, mono.variable)}>
      <body className="canvas-grid min-h-screen">
        <WalletProvider>
          <TooltipProvider delayDuration={150}>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
