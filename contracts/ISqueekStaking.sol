// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The parts of Squeekchain's SqueekStaking (Sepolia proxy 0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f,
/// implementation version 2) that ChickenTreasury uses. Squeeks deposited here earn SQK for the account that
/// deposited them; only that account can claim. Squeekchain's staking is in active development, so check
/// these signatures against the live contract before relying on them.
interface ISqueekStaking {
    function deposit(address collection, uint256[] calldata tokenIds) external;
    function withdraw(address collection, uint256[] calldata tokenIds) external;
    function claim(address account) external returns (uint256 amount);
    function claimable(address account) external view returns (uint256);
    function accountPower(address account) external view returns (uint256 nftPower, uint256 sqkPower);
}
