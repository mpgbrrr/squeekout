// Deploys ChickenTreasury for a game and switches on the NFT jackpot bonus.
//   DEPLOYER_PRIVATE_KEY  the game's owner; becomes the treasury's owner (the developer)
//   GAME_ADDRESS          the SqueekChicken game (defaults to deployments/<network>.json)
//   STAKING               SqueekStaking (defaults to Squeekchain's Sepolia proxy). Its reward token must be the
//                         game's token: real Squeeks earn real SQK, so the bonus needs a game played in SQK.
//   BONUS_DELAY           seconds after the hamster's last movement before a game's bonus is settled (2400)
// Then deposit Squeeks: approve the treasury for them and call depositNfts(collection, tokenIds) as the owner.
// Usage: npx hardhat run scripts/deploy-treasury.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const SEPOLIA_STAKING = "0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f";

async function main() {
  const env = process.env;
  const address = env.GAME_ADDRESS || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`))).address;
  const game = await ethers.getContractAt("SqueekChicken", address);
  const staking = env.STAKING || SEPOLIA_STAKING;
  const token = await game.sqk();
  const rewardToken = await new ethers.Contract(staking, ["function token() view returns (address)"], ethers.provider).token().catch(() => null);
  if (rewardToken && rewardToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error(`Staking pays ${rewardToken} but the game is played in ${token}: the bonus must be in the game's token`);
  }
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(token, staking);
  await treasury.waitForDeployment();
  await (await treasury.setGame(address)).wait();
  const delay = Number(env.BONUS_DELAY || 2400);
  await (await game.setTreasury(treasury.target, delay)).wait();
  console.log(JSON.stringify({ treasury: treasury.target, game: address, staking, token, bonusDelay: delay }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
