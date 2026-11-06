import { formatUnits, parseUnits } from "viem";
import { splitAgentDeposit } from "@perpetua/core";

const input = process.argv[2] ?? "10";
if (!/^\d+(?:\.\d{1,6})?$/.test(input)) throw new Error("Use a positive USD-equivalent deposit with at most six decimal places");
const split = splitAgentDeposit(parseUnits(input, 6));
console.log(JSON.stringify({
  depositUsd: formatUnits(split.depositUsd, 6), computeUsd: formatUnits(split.computeUsd, 6), tradingUsd: formatUnits(split.tradingUsd, 6),
  rule: "20% of the first deposit, capped at $5 equivalent", transfersPerformed: false,
  activation: "Requires a verified executable conversion route and sufficient credit for the chosen 0G provider",
}, null, 2));
