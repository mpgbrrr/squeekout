const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TestSQK", () => {
  it("lets anyone mint up to 10,000 per call", async () => {
    const [, alice] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("TestSQK")).deploy();
    await token.connect(alice).mint(alice.address, ethers.parseEther("10000"));
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("10000"));
    await expect(token.connect(alice).mint(alice.address, ethers.parseEther("10001"))).to.be.revertedWithCustomError(token, "MintTooLarge");
    expect(await token.symbol()).to.equal("tSQK");
  });
});
