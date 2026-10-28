// EIP-2612 permit: the player signs a message (free, no transaction) that lets the game take the buy-in,
// and the game's enterWithPermit uses it, so joining is one signature plus one transaction instead of
// an approval transaction plus a join transaction. No imports, so the watcher's tests can use it too.

const permitAbi = [
  { type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [
    { name: "fields", type: "bytes1" }, { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" },
    { name: "extensions", type: "uint256[]" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];

/**
 * Signs a permit for `value` of `token` to `spender`.
 * @param sign(typedData) asks the wallet to sign EIP-712 typed data and returns the 65-byte signature
 * @returns { deadline, v, r, s } for enterWithPermit
 */
export async function signPermit({ pub, sign, token, owner, spender, value, chainId, ttl = 1800 }) {
  // The token's own signing domain (ERC-5267), falling back to the usual name + version "1".
  const domain = await pub.readContract({ address: token, abi: permitAbi, functionName: "eip712Domain" })
    .then(([, name, version]) => ({ name, version }))
    .catch(async () => ({ name: await pub.readContract({ address: token, abi: permitAbi, functionName: "name" }), version: "1" }));
  const nonce = await pub.readContract({ address: token, abi: permitAbi, functionName: "nonces", args: [owner] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ttl);
  const sig = await sign({
    domain: { ...domain, chainId, verifyingContract: token },
    types: {
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  });
  const v = parseInt(sig.slice(130, 132), 16);
  return { deadline, r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: v < 27 ? v + 27 : v };
}
