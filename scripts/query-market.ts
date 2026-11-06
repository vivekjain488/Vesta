import "dotenv/config";
import { latestMarket, marketCandles, marketHistory } from "@perpetua/arkiv";
const symbol = process.argv[2] ?? "BTCUSDT"; const kind = process.argv[3] ?? "latest";
const result = kind === "candles" ? await marketCandles(symbol) : kind === "history" ? await marketHistory(symbol, Date.now() + 1, 10) : await latestMarket(symbol);
console.log(JSON.stringify(result, null, 2));
