// Generates fresh testnet-only deployer and watcher keys and writes them to a file outside the repo.
// Never reuse these keys on mainnet. Usage: node scripts/make-keys.mjs /path/outside/repo/keys.json
import { writeFileSync, existsSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const out = process.argv[2];
if (!out) throw new Error("Pass the output file path (outside the repo)");
if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite keys`);
const make = () => {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
};
const keys = { note: "Sepolia testnet only. Never send real funds to these addresses.", deployer: make(), watcher: make() };
writeFileSync(out, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
console.log(`deployer ${keys.deployer.address}\nwatcher  ${keys.watcher.address}\nKeys written to ${out}`);
