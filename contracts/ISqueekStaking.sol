// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The parts of Squeekchain's SqueekStaking (Sepolia proxy 0x50fd1780526c3186a0c037c7622203bc4fb611ca,
/// release core-sepolia-20261103, checked against its docs of 9 Nov 2026) that Squeek Out uses. Squeeks deposited here earn SQK for
/// the account that deposited them; only that account can claim. `genesis` is the Squeek collection; `clones`
/// is a second collection, zero on the current release. Squeekchain's staking is in active development, so check
/// these signatures against the live contract before relying on them.
interface ISqueekStaking {
    function token() external view returns (address);
    function genesis() external view returns (address);
    function clones() external view returns (address);
    function depositor(address collection, uint256 tokenId) external view returns (address);
    function deposit(address collection, uint256[] calldata tokenIds) external;
    function withdraw(address collection, uint256[] calldata tokenIds) external;
    function claim(address account) external returns (uint256 amount);
    function claimable(address account) external view returns (uint256);
    function mergeDeposited(address collection, uint256 survivor, uint256 donor) external;
    function stake(uint256 amount) external;
    function unstake(uint256 amount, uint256 maxFee, uint64 deadline) external returns (uint256 net);
    function quoteUnstake(address account, uint256 amount) external view returns (uint256 fee, uint256 net);
    function stakeOf(address account) external view returns (uint256 principal, uint256 freshPrincipal, uint64 freshUntilRound);
    function accountPower(address account) external view returns (uint256 nftPower, uint256 sqkPower);
}
