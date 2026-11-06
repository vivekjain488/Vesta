"use client";

import { PrivyProvider, useLogin, usePrivy, useWallets, type User, type EIP1193Provider } from "@privy-io/react-auth";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

type Gate = { ready: boolean; authenticated: boolean; addresses: string[]; connect(): Promise<string[]>; logout(): Promise<void>; ownerProvider(address: string): Promise<EIP1193Provider> };
const Context = createContext<Gate | null>(null);
export const usePrivyGate = () => { const value = useContext(Context); if (!value) throw new Error("Privy provider missing"); return value; };
function externalAddresses(user: User | null): string[] {
  return user?.linkedAccounts.flatMap((a) => a.type === "wallet" && a.chainType === "ethereum" && a.walletClientType !== "privy" ? [a.address.toLowerCase()] : []) ?? [];
}
function ConfiguredBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, logout: privyLogout, error } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const pending = useRef<{ resolve: (addresses: string[]) => void; reject: (error: Error) => void } | null>(null);
  const { login } = useLogin({
    onComplete: ({ user: loggedIn }) => { const p = pending.current; pending.current = null; if (p) p.resolve(externalAddresses(loggedIn)); },
    onError: () => { const p = pending.current; pending.current = null; p?.reject(new Error("Privy sign-in was cancelled or could not be completed.")); },
  });
  useEffect(() => () => { pending.current?.reject(new Error("Sign-in interrupted.")); pending.current = null; }, []);
  const addresses = externalAddresses(user);
  return <Context.Provider value={{
    ready: ready || !!error, authenticated, addresses,
    connect: () => {
      if (error) return Promise.reject(new Error(`Privy could not start: ${error.message}`));
      if (!ready) return Promise.reject(new Error("Privy is still loading. Try again in a moment."));
      if (authenticated) return Promise.resolve(addresses);
      if (pending.current) return Promise.reject(new Error("Sign-in is already in progress."));
      return new Promise<string[]>((resolve, reject) => { pending.current = { resolve, reject }; try { login({ loginMethods: ["wallet"] }); } catch (e) { pending.current = null; reject(e); } });
    },
    logout: async () => { if (authenticated) await privyLogout(); },
    ownerProvider: async (address) => {
      if (!walletsReady) throw new Error("Your connected wallet is still loading. Try again in a moment.");
      const wallet = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase() && w.walletClientType !== "privy" && w.walletClientType !== "privy-v2");
      if (!wallet) throw new Error("Reconnect your MetaMask account through Privy before making a deposit.");
      return wallet.getEthereumProvider();
    },
  }}>{children}</Context.Provider>;
}
export function PrivyBridge({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  if (!appId) return <Context.Provider value={{ ready: true, authenticated: false, addresses: [], connect: async () => { throw new Error("Privy is not configured. Set NEXT_PUBLIC_PRIVY_APP_ID and restart the frontend."); }, logout: async () => {}, ownerProvider: async () => { throw new Error("Privy is not configured."); } }}>{children}</Context.Provider>;
  return <PrivyProvider appId={appId}><ConfiguredBridge>{children}</ConfiguredBridge></PrivyProvider>;
}
