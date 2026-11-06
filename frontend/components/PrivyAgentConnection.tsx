"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useWallet } from "@/components/Wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function ConnectedPrivyAccount() {
  const { ready, authenticated, user, login, logout, error } = usePrivy();
  const { address } = useWallet();
  const matches = !!address && !!user?.linkedAccounts.some((account) =>
    account.type === "wallet" && account.chainType === "ethereum" && account.address.toLowerCase() === address.toLowerCase()
  );
  if (!ready) return <p className="text-sm text-muted-foreground">Loading wallet connection…</p>;
  if (error) return <p role="alert" className="text-sm text-muted-foreground">Could not initialize Privy: {error.message}</p>;
  if (!authenticated) return <div className="space-y-2"><p className="text-sm text-muted-foreground">Connect the same MetaMask account to Privy to prepare your agent wallet.</p><Button variant="outline" onClick={() => login({ loginMethods: ["wallet"] })}>Connect with Privy</Button></div>;
  if (!matches) return <div className="space-y-2"><p role="alert" className="text-sm text-muted-foreground">This Privy account is not linked to the MetaMask account signed in to Perpetua. Sign out of Privy and reconnect the same account.</p><Button variant="outline" onClick={() => void logout()}>Sign out of Privy</Button></div>;
  return <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Privy is connected to your MetaMask account. Agent wallet creation and funding are being prepared.</p><Button variant="outline" onClick={() => void logout()}>Disconnect Privy</Button></div>;
}

export function PrivyAgentConnection() {
  return <Card><CardHeader><CardTitle>Agent wallet</CardTitle><CardDescription>Connect Privy to prepare a separate wallet for this agent.</CardDescription></CardHeader><CardContent className="space-y-3">{process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ? <ConnectedPrivyAccount /> : <p className="text-sm text-muted-foreground">Privy is not configured.</p>}<p className="text-sm text-muted-foreground">Funding will be available once wallet creation and recovery are ready.</p><Button variant="outline" disabled>Fund with MetaMask</Button></CardContent></Card>;
}
