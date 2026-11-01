require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");

// Deployment settings come from the environment; nothing secret lives in this repo.
const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, SEPOLIA_GAS_PRICE } = process.env;

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } }],
    // The holders game is built with the IR code generator, which makes it about 4 KB smaller (18.9 KB of the
    // 24 KB contract size limit, instead of 23.2 KB), leaving room for upgrades.
    overrides: { "contracts/SqueekHolders.sol": { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } } },
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      // Optional fixed gas price in wei. Sepolia's base fee is often a few wei, but the default tip of 1 gwei can
      // make a deploy cost more than a testnet wallet holds.
      gasPrice: SEPOLIA_GAS_PRICE ? Number(SEPOLIA_GAS_PRICE) : "auto",
    },
  },
};
