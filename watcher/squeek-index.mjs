// Who holds which Squeek, for the holders game's page: Squeek collections can't list a wallet's tokens, so the
// watcher asks the chain who owns every token (a few hundred per call, about 3 seconds for 10,000), and who
// staked the ones held by Squeekchain's staking. The page uses it to pick a player's Squeek for them; the
// contract checks ownership itself on entry, so a stale index can only fail to find a Squeek, never let a
// non-holder in.
import { parseAbi } from "viem";

const abi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function depositor(address,uint256) view returns (address)",
]);
const BATCH = 500;
const REFRESH_MS = 3 * 60_000, MIN_RESCAN_MS = 30_000;

export function createSqueekIndex({ pub, staking, log }) {
  const stakingLc = staking.toLowerCase();
  let byHolder = new Map(); // holder (lowercase) -> [{ collection, tokenId, staked }]
  let scannedAt = 0, scanning = null, collections = [];

  async function many(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += BATCH) {
      const part = calls.slice(i, i + BATCH);
      out.push(...(await pub.multicall({ contracts: part, allowFailure: true }).catch(() => Promise.all(part.map((c) => // chains without Multicall3
        pub.readContract(c).then((result) => ({ status: "success", result }), () => ({ status: "failure" })))))));
    }
    return out;
  }

  async function scanCollection(collection) {
    const read = (functionName) => pub.readContract({ address: collection, abi, functionName }).catch(() => null);
    const top = Number((await read("MAX_SUPPLY")) ?? (await read("totalSupply")) ?? 10_000n);
    const ids = Array.from({ length: top + 1 }, (_, i) => BigInt(i)); // ids 0..top: collections start at 0 or 1
    const owners = await many(ids.map((id) => ({ address: collection, abi, functionName: "ownerOf", args: [id] })));
    const staked = ids.filter((_, i) => owners[i].status === "success" && owners[i].result.toLowerCase() === stakingLc);
    const stakers = await many(staked.map((id) => ({ address: staking, abi, functionName: "depositor", args: [collection, id] })));
    const found = [];
    owners.forEach((o, i) => {
      if (o.status === "success" && o.result.toLowerCase() !== stakingLc) found.push([o.result.toLowerCase(), { collection, tokenId: ids[i].toString(), staked: false }]);
    });
    stakers.forEach((s, i) => {
      if (s.status === "success" && /^0x[0-9a-fA-F]{40}$/.test(s.result) && BigInt(s.result) !== 0n) {
        found.push([s.result.toLowerCase(), { collection, tokenId: staked[i].toString(), staked: true }]);
      }
    });
    return found;
  }

  async function scan() {
    const t0 = Date.now();
    const next = new Map();
    for (const c of collections) {
      for (const [holder, squeek] of await scanCollection(c)) next.set(holder, [...(next.get(holder) ?? []), squeek]);
    }
    byHolder = next;
    scannedAt = Date.now();
    log("squeek_index", { holders: next.size, collections: collections.length, ms: Date.now() - t0 });
  }

  function rescan() {
    scanning ??= scan().catch((e) => log("squeek_index_failed", { error: String(e.shortMessage || e.message || e).slice(0, 200) }))
      .finally(() => { scanning = null; });
    return scanning;
  }

  return {
    /** From the watcher's chain work: keeps the index fresh for the game's collections. */
    async refresh(current) {
      const changed = current.join(",").toLowerCase() !== collections.join(",").toLowerCase();
      collections = current;
      if (changed || Date.now() - scannedAt > REFRESH_MS) await rescan();
    },

    /** A wallet's Squeeks, checked against the chain right now. Looks again if none are known and the index
     * is more than 30 s old (a Squeek bought or staked a moment ago). */
    async squeeksOf(address) {
      const key = address.toLowerCase();
      if (!byHolder.has(key) && Date.now() - scannedAt > MIN_RESCAN_MS) await rescan();
      const known = byHolder.get(key) ?? [];
      if (!known.length) return [];
      const checks = await many(known.map((s) => (s.staked
        ? { address: staking, abi, functionName: "depositor", args: [s.collection, BigInt(s.tokenId)] }
        : { address: s.collection, abi, functionName: "ownerOf", args: [BigInt(s.tokenId)] })));
      return known.filter((_, i) => checks[i].status === "success" && checks[i].result.toLowerCase() === key);
    },
  };
}
