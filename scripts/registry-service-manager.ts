/** Daily local import scheduler; credentials stay in the root .env, never the launchd plist. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(new URL("..", import.meta.url).pathname), label = "network.perpetua.chain-registry";
const domain = `gui/${process.getuid!()}`, target = `${domain}/${label}`, plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const launch = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf8" });
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
if (process.platform !== "darwin") throw new Error("Use the GitHub workflow or your host's daily scheduler outside macOS");
const command = process.argv[2] ?? "status";
if (command === "install") {
  const logs = resolve(root, ".perpetua/logs"); mkdirSync(logs, { recursive: true }); mkdirSync(dirname(plist), { recursive: true });
  if (existsSync(plist)) launch("bootout", domain, plist);
  const args = [process.execPath, "--import", "tsx", resolve(root, "arkiv/src/import-registry.ts")];
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>StartInterval</key><integer>86400</integer><key>RunAtLoad</key><false/><key>StandardOutPath</key><string>${xml(resolve(logs, "registry-import.stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(logs, "registry-import.stderr.log"))}</string></dict></plist>`, { mode: 0o600 });
  const r = launch("bootstrap", domain, plist); if (r.status !== 0) throw new Error(r.stderr.trim());
  console.log(`Installed daily registry refresh: ${target}. Run pnpm registry:import for an immediate refresh.`);
} else if (command === "status") {
  const r = launch("print", target); console.log(r.stdout || r.stderr); process.exitCode = r.status ?? 1;
} else if (command === "stop") {
  const r = launch("bootout", domain, plist); if (r.status !== 0) throw new Error(r.stderr.trim()); console.log("Daily registry scheduler stopped");
} else throw new Error("Usage: registry:service install | status | stop");
