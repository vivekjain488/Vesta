/** Install the market mirror as a per-user macOS service. No credentials are copied into the plist. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const label = "network.perpetua.market-mirror";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
if (process.platform !== "darwin") throw new Error("This supervisor installer targets macOS. On other hosts, supervise pnpm market with your service manager.");
const command = process.argv[2] ?? "status";
const launch = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf8" });
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
if (command === "install") {
  const logs = resolve(root, ".perpetua/logs"); mkdirSync(logs, { recursive: true }); mkdirSync(dirname(plist), { recursive: true });
  if (existsSync(plist)) launch("bootout", domain, plist);
  const args = [process.execPath, "--import", "tsx", resolve(root, "arkiv/src/market-service.ts")];
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(resolve(logs, "market.stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(logs, "market.stderr.log"))}</string></dict></plist>\n`, { mode: 0o600 });
  const result = launch("bootstrap", domain, plist); if (result.status !== 0) throw new Error(result.stderr.trim()); console.log(`Installed ${target}; starts at login and restarts after crashes.`);
} else if (command === "stop") {
  const result = launch("bootout", domain, plist); if (result.status !== 0) throw new Error(result.stderr.trim()); console.log("Market mirror stopped; published data remains in Arkiv.");
} else if (command === "start") {
  const result = launch("bootstrap", domain, plist); if (result.status !== 0) throw new Error(result.stderr.trim()); console.log("Market mirror started.");
} else if (command === "status") {
  const result = launch("print", target); console.log(result.stdout || result.stderr); process.exitCode = result.status ?? 1;
} else throw new Error("Usage: market-service-manager.ts install | status | stop | start");
