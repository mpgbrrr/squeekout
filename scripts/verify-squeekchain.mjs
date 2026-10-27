// Checks that a SqueekCore and an SQK token on Sepolia belong to one Squeekchain deployment before the
// game relies on them: SQK's only minter must be a SqueekMining that reads this SqueekCore, and the
// core's settled work must line up with Squeekchain's live feed. Read-only.
// Usage: node scripts/verify-squeekchain.mjs <squeekCore> <sqk>
import { readFileSync } from "node:fs";
import { createPublicClient, http, getAddress, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const [coreArg, sqkArg] = process.argv.slice(2);
if (!coreArg || !sqkArg) throw new Error("Usage: node scripts/verify-squeekchain.mjs <squeekCore> <sqk>");
const core = getAddress(coreArg), sqk = getAddress(sqkArg);
const RPC = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const coreAbi = JSON.parse(readFileSync(new URL("../contracts/abi/SqueekCore.json", import.meta.url)));
const tokenAbi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function cap() view returns (uint256)", "function totalSupply() view returns (uint256)", "function mining() view returns (address)",
]);
const miningAbi = parseAbi(["function core() view returns (address)", "function implementationCodeVersion() view returns (uint64)"]);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

if ((await client.getChainId()) !== sepolia.id) throw new Error("RPC is not Sepolia");
const blockNumber = (await client.getBlockNumber()) - 12n; // 12 confirmations, like Squeekchain's own views
const at = { blockNumber };

for (const [label, addr] of [["SqueekCore", core], ["SQK", sqk]]) {
  const code = await client.getCode({ address: addr, ...at });
  check(`${label} has contract code`, Boolean(code && code !== "0x"), addr);
}

const [name, symbol, decimals, cap, supply, mining] = await Promise.all(
  ["name", "symbol", "decimals", "cap", "totalSupply", "mining"].map((fn) => client.readContract({ address: sqk, abi: tokenAbi, functionName: fn, ...at })),
);
check("SQK is named Squeek / SQK with 18 decimals", name === "Squeek" && symbol === "SQK" && decimals === 18, `${name} / ${symbol} / ${decimals}`);
check("SQK lifetime cap is 2.1 billion", cap === 2_100_000_000n * 10n ** 18n, `${cap / 10n ** 18n} SQK`);

const miningCore = await client.readContract({ address: mining, abi: miningAbi, functionName: "core", ...at });
check("SQK's only minter (SqueekMining) reads this SqueekCore", getAddress(miningCore) === core, `mining ${mining} → core ${miningCore}`);

const config = await client.readContract({ address: core, abi: coreAbi, functionName: "configuration", ...at });
const state = await client.readContract({ address: core, abi: coreAbi, functionName: "state", ...at });
check("SqueekCore rounds are 600 s", config.roundDuration === 600n, `genesis ${new Date(Number(config.genesisTimestamp) * 1000).toISOString()}`);

const status = await (await fetch("https://api.squeekchain.com/v1/status")).json();
const live = BigInt(status.measurement.cumulativeWorkUnits);
const settled = state.cumulativeWork;
check("Live feed counter has not fallen behind SqueekCore's settled work", live >= settled,
  `live ${live}, settled ${settled} through round ${state.settledThroughRound}`);
check("SqueekCore is not paused", state.paused === false, "");

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
console.log(`\nRead at Sepolia block ${blockNumber}. SQK supply ${supply / 10n ** 18n} SQK.`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
