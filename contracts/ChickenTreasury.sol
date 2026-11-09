// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISqueekStaking} from "./ISqueekStaking.sol";

/// @title ChickenTreasury
/// @notice Holds the game's Squeek NFTs in Squeekchain's staking, where they earn SQK from the hamster's work.
/// Each harvest splits everything earned since the last one: `gameShareBps` to the game, which pays it out as a
/// game's prize, and the rest to the developer's balance. The owner sets the split (default 50/50). Only the game can harvest; only the owner (the
/// developer) can move the NFTs or withdraw the developer's half, both at any time.
/// To keep its share of the rewards as other holders merge, the owner can merge the treasury's Squeeks
/// (`mergeNfts`: the donor is burned and the survivor's power rises 10% above the pair) and stake the developer's
/// SQK (`stakeDev`, or automatically at each harvest with `compoundDev`), which earns more for every Squeek the
/// treasury holds. Rewards from both are split at the next harvest like any other.
/// @dev The treasury is the staking account, so only it can claim its rewards: nobody else can trigger or
/// redirect them. Its token must be the game's token.
contract ChickenTreasury is Ownable, IERC721Receiver {
    using SafeERC20 for IERC20;

    IERC20 public immutable sqk;
    ISqueekStaking public immutable staking;
    address public game;
    uint256 public devBalance; // the developer's share, waiting to be withdrawn
    uint16 public gameShareBps = 5000; // share of each harvest that goes to the game's prizes (5000 = 50%)
    uint256 public devStaked; // the developer's SQK staked in Squeekchain (principal; unstaking pays an exit fee)
    bool public compoundDev; // stake the developer's share of each harvest instead of holding it

    event GameSet(address game);
    event GameShareSet(uint16 gameShareBps);
    event Harvested(uint256 earned, uint256 toGame, uint256 toDeveloper);
    event DevWithdrawn(address to, uint256 amount);
    event NftsDeposited(address collection, uint256[] tokenIds);
    event NftsWithdrawn(address collection, uint256[] tokenIds, address to);
    event NftsMerged(address collection, uint256 survivor, uint256 donor);
    event DevStaked(uint256 amount);
    event DevUnstaked(uint256 amount, uint256 net);
    event CompoundDevSet(bool on);

    error NotGame();
    error TooMuch();

    constructor(IERC20 sqk_, ISqueekStaking staking_) Ownable(msg.sender) {
        sqk = sqk_;
        staking = staking_;
    }

    function setGame(address game_) external onlyOwner {
        game = game_;
        emit GameSet(game_);
    }

    /// @notice Sets the share of future harvests that goes to the game's prizes, in basis points (0-10000). It
    /// applies from the next harvest, to everything earned since the last one.
    function setGameShare(uint16 gameShareBps_) external onlyOwner {
        if (gameShareBps_ > 10_000) revert TooMuch();
        gameShareBps = gameShareBps_;
        emit GameShareSet(gameShareBps_);
    }

    /// @notice Moves the owner's Squeeks into the treasury and deposits them in staking. Approve the
    /// treasury for the NFTs first.
    function depositNfts(address collection, uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) IERC721(collection).transferFrom(msg.sender, address(this), tokenIds[i]);
        IERC721(collection).setApprovalForAll(address(staking), true);
        staking.deposit(collection, tokenIds);
        emit NftsDeposited(collection, tokenIds);
    }

    /// @notice Takes Squeeks out of staking and sends them to `to`. Rewards they already earned stay with
    /// the treasury and are split at the next harvest.
    function withdrawNfts(address collection, uint256[] calldata tokenIds, address to) external onlyOwner {
        staking.withdraw(collection, tokenIds);
        for (uint256 i = 0; i < tokenIds.length; i++) IERC721(collection).transferFrom(address(this), to, tokenIds[i]);
        emit NftsWithdrawn(collection, tokenIds, to);
    }

    /// @notice Merges two of the treasury's staked Squeeks of the same level: `donor` is burned and `survivor`
    /// rises one level, staying staked. Squeekchain enforces the rules (merges open, same level, cooldown).
    function mergeNfts(address collection, uint256 survivor, uint256 donor) external onlyOwner {
        staking.mergeDeposited(collection, survivor, donor);
        emit NftsMerged(collection, survivor, donor);
    }

    /// @notice Stakes `amount` of the developer's balance in Squeekchain. It earns from the next harvest on;
    /// taking it back (`unstakeDev`) costs Squeekchain's exit fee, which is burned.
    function stakeDev(uint256 amount) external onlyOwner {
        if (amount > devBalance) revert TooMuch();
        devBalance -= amount;
        _stake(amount);
    }

    /// @notice Unstakes `amount` of the developer's staked SQK (mature principal only) into the developer's
    /// balance, minus the exit fee. Quote the fee with the staking contract's `quoteUnstake(treasury, amount)`.
    function unstakeDev(uint256 amount, uint256 maxFee, uint64 deadline) external onlyOwner {
        if (amount > devStaked) revert TooMuch();
        devStaked -= amount;
        uint256 net = staking.unstake(amount, maxFee, deadline);
        devBalance += net;
        emit DevUnstaked(amount, net);
    }

    /// @notice When on, the developer's share of each harvest is staked instead of held.
    function setCompoundDev(bool on) external onlyOwner {
        compoundDev = on;
        emit CompoundDevSet(on);
    }

    function _stake(uint256 amount) private {
        sqk.forceApprove(address(staking), amount);
        staking.stake(amount);
        devStaked += amount;
        emit DevStaked(amount);
    }

    /// @dev Used by harvest, which must never fail because staking does.
    function stakeFromHarvest(uint256 amount) external {
        if (msg.sender != address(this)) revert NotGame();
        _stake(amount);
    }

    function withdrawDev(address to, uint256 amount) external onlyOwner {
        if (amount > devBalance) revert TooMuch();
        devBalance -= amount;
        sqk.safeTransfer(to, amount);
        emit DevWithdrawn(to, amount);
    }

    /// @notice Claims the NFTs' rewards and splits everything earned since the last harvest: `gameShareBps` to
    /// the game (returned and sent to it), the rest to the developer's balance.
    function harvest() external returns (uint256 toGame) {
        if (msg.sender != game) revert NotGame();
        // A problem in staking must never block the game, so a failed claim just harvests what's here.
        try staking.claimable(address(this)) returns (uint256 owed) {
            if (owed > 0) try staking.claim(address(this)) {} catch {}
        } catch {}
        uint256 earned = sqk.balanceOf(address(this)) - devBalance;
        toGame = (earned * gameShareBps) / 10_000;
        uint256 toDev = earned - toGame;
        // Staking may be paused or refuse; then the developer's share is simply held as usual.
        if (compoundDev && toDev > 0) try this.stakeFromHarvest(toDev) {} catch { devBalance += toDev; }
        else devBalance += toDev;
        if (toGame > 0) sqk.safeTransfer(game, toGame);
        emit Harvested(earned, toGame, earned - toGame);
    }

    /// @notice The game's share of what has been earned since the last harvest, including rewards still in
    /// staking: the prize so far.
    function pendingToGame() external view returns (uint256) {
        uint256 owed;
        try staking.claimable(address(this)) returns (uint256 o) {
            owed = o;
        } catch {}
        return ((owed + sqk.balanceOf(address(this)) - devBalance) * gameShareBps) / 10_000;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
