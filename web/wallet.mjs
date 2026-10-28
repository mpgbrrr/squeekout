// Wallet connection for the game and results pages. Finds every installed browser wallet (EIP-6963, the
// standard RainbowKit and other connectors use) instead of whichever one grabbed window.ethereum, lets the
// player pick one, remembers it and reconnects quietly on the next visit, follows account and network
// changes in the wallet, and keeps transactions on the game's chain (adding Sepolia to the wallet if needed).

const STORE_KEY = "chickenWallet"; // the chosen wallet's rdns, to reconnect quietly next time
const store = {
  get: () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); } catch {} },
};

// Wallets announce themselves in answer to this event, now and whenever one loads later.
const announced = new Map(); // uuid -> { info: { uuid, name, icon, rdns }, provider }
window.addEventListener("eip6963:announceProvider", (e) => {
  if (e.detail?.info?.uuid && e.detail.provider) announced.set(e.detail.info.uuid, e.detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

/** Installed wallets. Waits briefly for announcements; falls back to window.ethereum for older wallets. */
export async function installedWallets(wait = 250) {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, wait));
  const list = [...announced.values()];
  if (!list.length && window.ethereum) {
    list.push({ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum });
  }
  return list;
}

/**
 * @param chain viem chain the game runs on (id, name, rpcUrls, blockExplorers, nativeCurrency)
 * @param onChange({ address, chainId, name }) called whenever the connection changes (address null when disconnected)
 */
export function createWallet({ chain, onChange }) {
  let current = null; // { info, provider }
  let address = null, chainId = null;
  const hex = `0x${chain.id.toString(16)}`;

  const emit = () => onChange({ address, chainId, name: current?.info.name ?? null, wrongChain: !!address && chainId !== chain.id });
  const onAccounts = (accounts) => {
    address = accounts?.[0] ?? null;
    if (!address) forget(false);
    emit();
  };
  const onChain = (id) => { chainId = Number(id); emit(); };
  const onDisconnect = () => { address = null; emit(); };

  function attach(w) {
    detach();
    current = w;
    w.provider.on?.("accountsChanged", onAccounts);
    w.provider.on?.("chainChanged", onChain);
    w.provider.on?.("disconnect", onDisconnect);
  }
  function detach() {
    if (!current) return;
    current.provider.removeListener?.("accountsChanged", onAccounts);
    current.provider.removeListener?.("chainChanged", onChain);
    current.provider.removeListener?.("disconnect", onDisconnect);
    current = null;
  }
  function forget(clearStore = true) {
    detach();
    address = null;
    chainId = null;
    if (clearStore) store.set(null);
  }

  async function use(w, prompt) {
    attach(w);
    const accounts = await w.provider.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
    if (!accounts?.length) { forget(true); emit(); return false; }
    address = accounts[0];
    chainId = Number(await w.provider.request({ method: "eth_chainId" }));
    store.set(w.info.rdns);
    emit();
    return true;
  }

  return {
    get address() { return address; },
    get provider() { return current?.provider ?? null; },
    get name() { return current?.info.name ?? null; },

    /** Connects to the chosen wallet, asking the player to approve. */
    connect: (w) => use(w, true),

    /** On page load: reconnects to the wallet used last time if it still allows this site, without a prompt. */
    async reconnect() {
      const rdns = store.get();
      if (!rdns) return false;
      const w = (await installedWallets(400)).find((x) => x.info.rdns === rdns);
      if (!w) return false;
      try { return await use(w, false); } catch { return false; }
    },

    /** Forgets the wallet here and, where the wallet supports it, drops this site's permission. */
    async disconnect() {
      const p = current?.provider;
      forget(true);
      emit();
      try { await p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
    },

    /** Makes sure the wallet is on the game's chain, adding the chain to the wallet first if it doesn't know it. */
    async ensureChain() {
      const p = current?.provider;
      if (!p) throw new Error("Connect a wallet first.");
      if (Number(await p.request({ method: "eth_chainId" })) === chain.id) return;
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e;
        await p.request({ method: "wallet_addEthereumChain", params: [{
          chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
        }] });
        // Some wallets switch to a chain when they add it; others need asking again.
        if (Number(await p.request({ method: "eth_chainId" })) !== chain.id) {
          await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        }
      }
      chainId = Number(await p.request({ method: "eth_chainId" }));
      if (chainId !== chain.id) throw Object.assign(new Error(`Switch your wallet to ${chain.name}.`), { code: "WRONG_CHAIN" });
      emit();
    },
  };
}

/** The address of the wallet this site used last, if it still allows the site: no prompt. */
export async function quietAddress() {
  const rdns = store.get();
  if (!rdns) return null;
  const w = (await installedWallets(400)).find((x) => x.info.rdns === rdns);
  try { return (await w?.provider.request({ method: "eth_accounts" }))?.[0] ?? null; } catch { return null; }
}

/** A wallet error in plain words. */
export function walletErrorText(e) {
  const code = e?.code ?? e?.cause?.code;
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.details ?? ""}`;
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(text)) return "You cancelled it in your wallet.";
  if (code === -32002 || /already pending/i.test(text)) return "Your wallet already has a request waiting: open the wallet to answer it.";
  if (/insufficient funds/i.test(text)) return "Your wallet needs a little Sepolia ETH to pay for gas.";
  if (code === "WRONG_CHAIN" || /chain mismatch|does not match the target chain/i.test(text)) return "Your wallet is on the wrong network. Switch it to Sepolia and try again.";
  return e?.shortMessage || e?.message || String(e);
}
