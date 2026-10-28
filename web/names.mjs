// How players are named on the game and results pages: by their ENS name when their address has one (looked
// up on Ethereum mainnet, where ENS names live, and checked both ways by viem), otherwise by short address.
// Test players run by the watcher show by name with a robot.
import { createPublicClient, http } from "https://esm.sh/viem@2.21.55";
import { mainnet } from "https://esm.sh/viem@2.21.55/chains";

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** bots: [{ address, name }] from the watcher's /config.json. onName is called when a new ENS name arrives. */
export function createNames(bots = [], onName = () => {}) {
  const ens = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
  const found = new Map(); // lowercase address -> name, or null while looking up / when there is none
  const botNames = new Map(bots.map((b) => [b.address.toLowerCase(), b.name]));
  function ensName(a) {
    const k = a.toLowerCase();
    if (!found.has(k)) {
      found.set(k, null);
      ens.getEnsName({ address: a }).then((name) => { if (name) { found.set(k, name); onName(); } }).catch(() => {});
    }
    return found.get(k);
  }
  return {
    ensName,
    playerName: (a) => (botNames.has(a.toLowerCase()) ? `🤖 ${botNames.get(a.toLowerCase())}` : ensName(a) ?? short(a)),
  };
}
