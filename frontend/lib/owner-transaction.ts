import { toHex } from "viem";
import type { EIP1193Provider } from "@privy-io/react-auth";

/** Obtain account permission before switching networks. Never retry a transaction submission. */
export async function sendOwnerTransaction(getProvider: () => Promise<EIP1193Provider>, address: string, to: string, data: string, chainId: number, value?: bigint): Promise<string> {
  let eth = await getProvider();
  let accounts: string[];
  try {
    accounts = await eth.request({ method: "eth_accounts" }) as string[];
    if (!accounts.some((a) => a.toLowerCase() === address.toLowerCase())) accounts = await eth.request({ method: "eth_requestAccounts" }) as string[];
  } catch (error: any) {
    if (error?.code === 4001) throw new Error("MetaMask connection was cancelled. Connect your account to continue.");
    if (error?.code === 4100) throw new Error("MetaMask has not authorized this site. Reconnect your account in MetaMask, then try again.");
    throw error;
  }
  if (!accounts.some((a) => a.toLowerCase() === address.toLowerCase())) throw new Error("Connect the same MetaMask account you used to sign in.");
  if (Number.parseInt(await eth.request({ method: "eth_chainId" }), 16) !== chainId) {
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(chainId) }] }); }
    catch (error: any) {
      if (error?.code === 4100) throw new Error("MetaMask has not authorized this site to switch networks. Reconnect your account in MetaMask and retry.");
      if (error?.code !== 4902 || chainId !== 31337) throw error;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: toHex(chainId), chainName: "VESTA Local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["http://127.0.0.1:8545"] }] });
    }
    eth = await getProvider();
  }
  if (Number.parseInt(await eth.request({ method: "eth_chainId" }), 16) !== chainId) throw new Error("Select the agent's network in MetaMask before continuing");
  accounts = await eth.request({ method: "eth_accounts" }) as string[];
  if (!accounts.some((a) => a.toLowerCase() === address.toLowerCase())) throw new Error("Reconnect the owning wallet");
  try { return await eth.request({ method: "eth_sendTransaction", params: [{ from: address, to, data, ...(value ? { value: toHex(value) } : {}) }] }) as string; }
  catch (error: any) { if (error?.code === 4100) throw new Error("MetaMask has not authorized transactions for this account. Reconnect it in MetaMask and retry."); throw error; }
}
