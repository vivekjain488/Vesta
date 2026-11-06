import "dotenv/config";
import { registryHead, registryChains, registryChain, registryRpcs, resolveRegistryRpc } from "@perpetua/arkiv";
const command = process.argv[2] ?? "status", argument = process.argv[3];
const result = command === "status" ? await registryHead() : command === "chain" ? await registryChain(Number(argument)) : command === "rpcs" ? await registryRpcs(Number(argument)) : command === "resolve" ? await resolveRegistryRpc(Number(argument), { fresh: true }) : command === "list" ? await registryChains({ namePrefix: argument, limit: 25 }) : (() => { throw new Error("Usage: registry:query status | list [name prefix] | chain <id> | rpcs <id> | resolve <id>"); })();
console.log(JSON.stringify(result, null, 2));
