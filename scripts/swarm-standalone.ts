/** Swarm storage demonstration. */
import "dotenv/config";
import { gatewayLink, swarmDownloadJson, swarmStatus, swarmUploadJson } from "../arkiv/src/swarm";

const command = process.argv[2] ?? "status";
if (command === "status") {
  console.log(JSON.stringify(await swarmStatus(), null, 2));
} else if (command === "demo") {
  const payload = { application: "Perpetua", demonstration: "standalone Swarm storage", createdAt: new Date().toISOString() };
  const upload = await swarmUploadJson(payload, { encrypt: false, name: "perpetua-demo.json" });
  const downloaded = await swarmDownloadJson(upload.reference);
  console.log(JSON.stringify({ upload, downloaded, gateway: gatewayLink(upload.reference) }, null, 2));
} else {
  throw new Error("Usage: pnpm exec tsx scripts/swarm-standalone.ts [status|demo]");
}
