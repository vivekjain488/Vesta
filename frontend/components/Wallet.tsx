"use client";
/**
 * Follower wallet. With NEXT_PUBLIC_PRIVY_APP_ID set, followers log in with a Privy embedded wallet (works with
 * Flash as an EOA or EIP-1271 smart wallet); otherwise any injected wallet. Either way the FOLLOWER signs their
 * own Flash order: Perpetua never takes custody.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";

interface WalletCtx {
  address: string | null;
  connect: () => Promise<string | null>;
  signMessage: (message: string) => Promise<string>;
  signTypedDataJson: (json: string) => Promise<string>;
  kind: "privy" | "injected";
}

const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("WalletProvider missing");
  return c;
};

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export function WalletProvider({ children }: { children: ReactNode }) {
  if (PRIVY_APP_ID) {
    return (
      <PrivyProvider appId={PRIVY_APP_ID} config={{ embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } }, appearance: { theme: "dark" } }}>
        <PrivyBridge>{children}</PrivyBridge>
      </PrivyProvider>
    );
  }
  return <InjectedBridge>{children}</InjectedBridge>;
}

async function signWith(provider: any, address: string, json: string) {
  return provider.request({ method: "eth_signTypedData_v4", params: [address, json] }) as Promise<string>;
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { login, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const w = wallets[0];
  const value = useMemo<WalletCtx>(
    () => ({
      kind: "privy",
      address: authenticated && w ? w.address : null,
      connect: async () => { login(); return null; },
      signMessage: async (message) => {
        if (!w) throw new Error("Connect your wallet first");
        const provider = await w.getEthereumProvider();
        const { toHex } = await import("viem");
        return provider.request({ method: "personal_sign", params: [toHex(message), w.address] }) as Promise<string>;
      },
      signTypedDataJson: async (json) => {
        if (!w) throw new Error("no wallet");
        return signWith(await w.getEthereumProvider(), w.address, json);
      },
    }),
    [authenticated, w, login],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function InjectedBridge({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const connect = useCallback(async () => {
    const eth = (globalThis as any).ethereum;
    if (!eth) throw new Error("No wallet found. Install one, or set NEXT_PUBLIC_PRIVY_APP_ID for embedded wallets.");
    const [a] = await eth.request({ method: "eth_requestAccounts" });
    setAddress(a);
    return a as string;
  }, []);
  const value = useMemo<WalletCtx>(
    () => ({
      kind: "injected",
      address,
      connect,
      signMessage: async (message) => {
        if (!address) throw new Error("Connect your wallet first");
        const { toHex } = await import("viem");
        return (globalThis as any).ethereum.request({ method: "personal_sign", params: [toHex(message), address] }) as Promise<string>;
      },
      signTypedDataJson: async (json) => signWith((globalThis as any).ethereum, address!, json),
    }),
    [address, connect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
