"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { toHex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { apiFetch } from "@/lib/api";
import { usePrivyGate } from "@/components/PrivyBridge";
import { sendOwnerTransaction } from "@/lib/owner-transaction";

interface WalletCtx {
  address: string | null; ready: boolean; kind: "injected";
  connect(expectedAddresses?: string[]): Promise<string | null>; logout(): Promise<void>;
  signMessage(message: string): Promise<string>; signTypedDataJson(json: string): Promise<string>;
  sendTransaction(to: string, data: string, chainId: number, value?: bigint): Promise<string>;
  switchChain(chainId: number): Promise<void>; waitForTransaction(hash: string): Promise<void>;
}
const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => { const value = useContext(Ctx); if (!value) throw new Error("WalletProvider missing"); return value; };
function provider() { const eth = (globalThis as any).ethereum; return eth?.providers?.find((p: any) => p.isMetaMask) ?? (eth?.isMetaMask ? eth : undefined); }
async function response(res: Response) { const value = await res.json(); if (!res.ok) throw new Error(value.error ?? "Sign-in failed"); return value; }
export function WalletProvider({ children }: { children: ReactNode }) {
  const privy = usePrivyGate();
  const [address, setAddress] = useState<string | null>(null); const [ready, setReady] = useState(false);
  const logout = useCallback(async () => { setAddress(null); await apiFetch("/auth/logout", { method: "POST" }); }, []);
  useEffect(() => {
    let active = true;
    apiFetch("/auth/session").then(response).then((s) => { if (active) setAddress(s.address); }).catch(() => { if (active) setAddress(null); }).finally(() => { if (active) setReady(true); });
    const eth = provider(); const changed = () => { void logout(); };
    eth?.on?.("accountsChanged", changed); eth?.on?.("disconnect", changed);
    return () => { active = false; eth?.removeListener?.("accountsChanged", changed); eth?.removeListener?.("disconnect", changed); };
  }, [logout]);
  const connect = useCallback(async (expectedAddresses?: string[]) => {
    const eth = provider(); if (!eth) throw new Error("Install or unlock MetaMask to sign in.");
    const [account] = await eth.request({ method: "eth_requestAccounts" }); const chainId = Number.parseInt(await eth.request({ method: "eth_chainId" }), 16);
    if (!account || (expectedAddresses && !expectedAddresses.includes(account.toLowerCase()))) throw new Error("Connect the same MetaMask account in Privy and VESTA.");
    const challenge = await response(await apiFetch("/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, chainId }) }));
    const parsed = parseSiweMessage(challenge.message);
    if (parsed.domain !== location.host || parsed.uri !== location.origin || parsed.address?.toLowerCase() !== account.toLowerCase() || parsed.chainId !== chainId || parsed.nonce !== challenge.nonce) throw new Error("Sign-in request does not match this site or wallet");
    const signature = await eth.request({ method: "personal_sign", params: [toHex(challenge.message), account] });
    const session = await response(await apiFetch("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: challenge.nonce, signature }) }));
    setAddress(session.address); return session.address as string;
  }, []);
  const value: WalletCtx = {
    address, ready, kind: "injected", connect, logout,
    signMessage: async (message) => { if (!address) throw new Error("Sign in first"); return provider().request({ method: "personal_sign", params: [toHex(message), address] }); },
    signTypedDataJson: async (json) => { if (!address) throw new Error("Sign in first"); return provider().request({ method: "eth_signTypedData_v4", params: [address, json] }); },
    switchChain: async (chainId) => {
      const eth = provider(); if (!eth || !address) throw new Error("Sign in with MetaMask first");
      if (Number.parseInt(await eth.request({ method: "eth_chainId" }), 16) !== chainId) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(chainId) }] });
      if (Number.parseInt(await eth.request({ method: "eth_chainId" }), 16) !== chainId) throw new Error("Select Base in MetaMask");
    },
    waitForTransaction: async (hash) => {
      const eth = provider(); if (!eth) throw new Error("Wallet unavailable; check the approval on Base before retrying");
      for (let i = 0; i < 90; i++) {
        const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (receipt) { if (receipt.status !== "0x1") throw new Error("USDC approval transaction reverted"); return; }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error("Approval is still pending. Check its status before requesting a fresh quote.");
    },
    sendTransaction: async (to, data, chainId, value) => {
      if (!address) throw new Error("Sign in with MetaMask first");
      return sendOwnerTransaction(() => privy.ownerProvider(address), address, to, data, chainId, value);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
