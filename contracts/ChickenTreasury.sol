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
/// @dev The treasury is the staking account, so only it can claim its rewards: nobody else can trigger or
/// redirect them. Its token must be the game's token.
contract ChickenTreasury is Ownable, IERC721Receiver {
    using SafeERC20 for IERC20;

    IERC20 public immutable sqk;
    ISqueekStaking public immutable staking;
    address public game;
    uint256 public devBalance; // the developer's share, waiting to be withdrawn
    uint16 public gameShareBps = 5000; // share of each harvest that goes to the game's prizes (5000 = 50%)

    event GameSet(address game);
    event GameShareSet(uint16 gameShareBps);
    event Harvested(uint256 earned, uint256 toGame, uint256 toDeveloper);
    event DevWithdrawn(address to, uint256 amount);
    event NftsDeposited(address collection, uint256[] tokenIds);
    event NftsWithdrawn(address collection, uint256[] tokenIds, address to);

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
        devBalance += earned - toGame;
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
