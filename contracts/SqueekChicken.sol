// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISqueekCore} from "./ISqueekCore.sol";

/// @title SqueekChicken
/// @notice A game of chicken on Squeektoshi's wheel. Players buy in with SQK while the lobby is open; the
/// lobby closes when the hamster starts running. Once he runs, players exit whenever they like. The game
/// ends at his last movement once the wheel has been still for `idleWindow` seconds. Anyone still in, or
/// who exited too late, is caught. Winners split the pot in proportion to how long they stayed on, and the last 10% of
/// winners share a jackpot. When a game finishes, the watcher opens the next one.
/// @dev Testnet build. A watcher service reads Squeekchain's live feed and posts start, end and void
/// decisions; it cannot move funds or choose winners. When enabled, `finalize` checks the watcher's end
/// claim against SqueekCore's settled rounds before any payout.
contract SqueekChicken is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Lobby, // entries open until the hamster starts running (not before earliestStart)
        Live, // start posted; entries closed
        Ended, // end posted; waiting for finalize
        Settled, // payouts fixed; winners claim
        Voided, // everyone still entered claims their buy-in back
        RolledOver // everyone was caught; the pot moved to `rolloverPool`
    }

    struct Params {
        uint128 buyIn; // SQK base units per player
        uint64 earliestStart; // unix seconds; the game can't start before this, so the lobby has time to fill
        uint32 idleWindow; // seconds of stillness that end the game (agreed: 180)
        uint32 grace; // seconds after the last movement an exit still wins (agreed: 12)
        uint16 jackpotBps; // share of the pot for the jackpot (agreed: 2000)
        uint16 jackpotGroupBps; // share of winners who split the jackpot (agreed: 1000)
        uint128 bountyFlat; // SQK paid to whoever calls finalize, capped at 1% of the pot
        uint16 minPlayers; // fewer players in at the start voids the game
        uint16 maxPlayers;
    }

    struct Game {
        Params p;
        Status status;
        uint64 startTime; // the hamster's first movement after earliestStart
        uint64 lastMove;
        uint64 endCounter;
        uint32 entrants; // entered and not left during the lobby
        uint256 rolloverIn; // pot carried in from earlier all-caught games
        // fixed at finalize
        uint256 curvePool;
        uint256 sumWeights;
        uint256 jackpotEach;
        uint64 jackpotFromTime; // winners who exited at or after this time share the jackpot
    }

    struct Entry {
        bool entered;
        bool left; // left during the lobby and was refunded
        bool claimed;
        uint64 enteredAt; // entries after the start are late and refunded
        uint64 exitTime; // 0 while still in
    }

    uint256 public constant BOUNTY_CAP_BPS = 100; // 1% of the pot
    uint256 public constant BACKSTOP_DELAY = 7 days;

    IERC20 public immutable sqk;
    address public watcher;

    ISqueekCore public squeekCore;
    bool public roundCheckEnabled;
    uint64 public coreGenesis;
    uint64 public coreRoundDuration;

    Params public defaults; // settings for games the watcher opens; earliestStart is ignored
    uint32 public minLobby; // seconds a watcher-opened game's lobby stays open at least

    uint256 public rolloverPool;
    uint256 public gameCount;

    mapping(uint256 => Game) internal games;
    mapping(uint256 => mapping(address => Entry)) public entries;
    mapping(uint256 => address[]) internal players;
    mapping(uint256 => address[]) internal exitOrder; // exits in the order they happened (block time never decreases)

    event GameCreated(uint256 indexed id, Params params, uint256 rolloverIn);
    event Entered(uint256 indexed id, address indexed player);
    event LeftLobby(uint256 indexed id, address indexed player);
    event Exited(uint256 indexed id, address indexed player, uint64 exitTime);
    event Started(uint256 indexed id, uint64 startTime);
    event EndPosted(uint256 indexed id, uint64 lastMove, uint64 counter);
    event Voided(uint256 indexed id, string reason);
    event Settled(uint256 indexed id, uint256 pot, uint256 bounty, uint256 winners, uint256 jackpotWinners, address finalizer);
    event RolledOver(uint256 indexed id, uint256 amount, address finalizer);
    event Claimed(uint256 indexed id, address indexed player, uint256 amount);
    event WatcherSet(address watcher);
    event RoundCheckSet(address core, bool enabled, uint64 genesis, uint64 roundDuration);
    event DefaultsSet(Params params, uint32 minLobby);

    error NotWatcher();
    error WrongStatus(Status status);
    error AlreadyEntered();
    error NotEntered();
    error AlreadyExited();
    error LateEntry();
    error GameFull();
    error GameInProgress();
    error BadTime();
    error NothingToClaim();
    error RoundCheckPending();
    error BadParams();

    modifier onlyWatcher() {
        if (msg.sender != watcher) revert NotWatcher();
        _;
    }

    constructor(IERC20 sqk_, address watcher_) Ownable(msg.sender) {
        sqk = sqk_;
        watcher = watcher_;
        emit WatcherSet(watcher_);
    }

    // ------------------------------------------------------------------ admin (testnet)

    function setWatcher(address watcher_) external onlyOwner {
        watcher = watcher_;
        emit WatcherSet(watcher_);
    }

    /// @notice Points the settled-round check at a SqueekCore deployment and switches it on or off.
    function setRoundCheck(ISqueekCore core, bool enabled) external onlyOwner {
        squeekCore = core;
        roundCheckEnabled = enabled;
        if (address(core) != address(0)) {
            ISqueekCore.CoreConfiguration memory c = core.configuration();
            coreGenesis = c.genesisTimestamp;
            coreRoundDuration = c.roundDuration;
        }
        emit RoundCheckSet(address(core), enabled, coreGenesis, coreRoundDuration);
    }

    /// @notice Sets the rules for games the watcher opens automatically.
    function setDefaults(Params calldata p, uint32 minLobby_) external onlyOwner {
        _validate(p);
        defaults = p;
        minLobby = minLobby_;
        emit DefaultsSet(p, minLobby_);
    }

    function createGame(Params calldata p) external onlyOwner returns (uint256 id) {
        if (p.earliestStart <= block.timestamp) revert BadParams();
        return _create(p);
    }

    /// @notice Opens the next game with the default rules once the latest game has finished.
    function openNextGame() external onlyWatcher returns (uint256 id) {
        if (gameCount > 0) {
            Status s = games[gameCount].status;
            if (s != Status.Settled && s != Status.Voided && s != Status.RolledOver) revert GameInProgress();
        }
        Params memory p = defaults;
        if (p.buyIn == 0) revert BadParams();
        p.earliestStart = uint64(block.timestamp + minLobby);
        return _create(p);
    }

    // ------------------------------------------------------------------ players

    /// @notice Buy in. Open until the game starts; an entry that lands after the hamster's first movement
    /// (before the watcher has posted it) is refunded.
    function enter(uint256 id) public nonReentrant {
        Game storage g = games[id];
        if (g.status != Status.Lobby) revert WrongStatus(g.status);
        Entry storage e = entries[id][msg.sender];
        if (e.entered) revert AlreadyEntered();
        if (g.entrants >= g.p.maxPlayers) revert GameFull();
        e.entered = true;
        e.enteredAt = uint64(block.timestamp);
        g.entrants += 1;
        players[id].push(msg.sender);
        sqk.safeTransferFrom(msg.sender, address(this), g.p.buyIn);
        emit Entered(id, msg.sender);
    }

    /// @notice Approve and enter in one transaction using an EIP-2612 permit signature.
    function enterWithPermit(uint256 id, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        // A permit that was already used (for example front-run) still leaves a valid allowance.
        try IERC20Permit(address(sqk)).permit(msg.sender, address(this), games[id].p.buyIn, deadline, v, r, s) {} catch {}
        enter(id);
    }

    /// @notice Leave the lobby with an immediate refund, any time before the game starts.
    function leaveLobby(uint256 id) external nonReentrant {
        Game storage g = games[id];
        if (g.status != Status.Lobby) revert WrongStatus(g.status);
        Entry storage e = entries[id][msg.sender];
        if (!e.entered || e.left || e.exitTime != 0) revert NotEntered();
        e.left = true;
        e.claimed = true;
        g.entrants -= 1;
        sqk.safeTransfer(msg.sender, g.p.buyIn);
        emit LeftLobby(id, msg.sender);
    }

    /// @notice Get off the wheel. Allowed until the end is posted; an exit before the start is a refund.
    function exit(uint256 id) external {
        Game storage g = games[id];
        if (g.status != Status.Lobby && g.status != Status.Live) revert WrongStatus(g.status);
        Entry storage e = entries[id][msg.sender];
        if (!e.entered || e.left) revert NotEntered();
        if (e.exitTime != 0) revert AlreadyExited();
        if (g.status == Status.Live && e.enteredAt > g.startTime) revert LateEntry();
        e.exitTime = uint64(block.timestamp);
        exitOrder[id].push(msg.sender);
        emit Exited(id, msg.sender, e.exitTime);
    }

    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        amount = claimable(id, msg.sender);
        if (amount == 0) revert NothingToClaim();
        entries[id][msg.sender].claimed = true;
        sqk.safeTransfer(msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------ watcher

    /// @param startTime device time of the hamster's first movement at or after earliestStart
    function postStart(uint256 id, uint64 startTime) external onlyWatcher {
        Game storage g = games[id];
        if (g.status != Status.Lobby) revert WrongStatus(g.status);
        if (startTime < g.p.earliestStart || startTime > block.timestamp) revert BadTime();
        g.startTime = startTime;
        if (_inAtStart(id, g) < g.p.minPlayers) {
            _void(id, g, "not enough players");
            return;
        }
        g.status = Status.Live;
        emit Started(id, startTime);
    }

    /// @param lastMove device time of the hamster's last movement
    /// @param counter the wheel's work counter at that movement, checked against settled rounds
    function postEnd(uint256 id, uint64 lastMove, uint64 counter) external onlyWatcher {
        Game storage g = games[id];
        if (g.status != Status.Live) revert WrongStatus(g.status);
        if (lastMove < g.startTime || uint256(lastMove) + g.p.idleWindow > block.timestamp) revert BadTime();
        g.lastMove = lastMove;
        g.endCounter = counter;
        g.status = Status.Ended;
        emit EndPosted(id, lastMove, counter);
    }

    /// @notice Used for the outage rule: the feed dropped and the outcome cannot be known.
    function voidGame(uint256 id, string calldata reason) external onlyWatcher {
        Game storage g = games[id];
        if (g.status != Status.Lobby && g.status != Status.Live && g.status != Status.Ended) revert WrongStatus(g.status);
        _void(id, g, reason);
    }

    // ------------------------------------------------------------------ anyone

    /// @notice Refunds a game that could not finish within 7 days of its earliest start.
    function backstop(uint256 id) external {
        Game storage g = games[id];
        if (g.status != Status.Lobby && g.status != Status.Live && g.status != Status.Ended) revert WrongStatus(g.status);
        if (block.timestamp < uint256(g.p.earliestStart) + BACKSTOP_DELAY) revert BadTime();
        _void(id, g, "backstop");
    }

    /// @notice Fixes the payouts once the end is posted (and, if enabled, confirmed by settled rounds).
    /// The caller receives the bounty.
    function finalize(uint256 id) external nonReentrant {
        Game storage g = games[id];
        if (g.status != Status.Ended) revert WrongStatus(g.status);
        if (roundCheckEnabled) {
            int8 check = _roundCheck(g);
            if (check == 0) revert RoundCheckPending();
            if (check < 0) {
                _void(id, g, "round check failed");
                return;
            }
        }

        uint256 pot = uint256(g.p.buyIn) * _inAtStart(id, g) + g.rolloverIn;
        uint256 bounty = g.p.bountyFlat;
        uint256 cap = (pot * BOUNTY_CAP_BPS) / 10_000;
        if (bounty > cap) bounty = cap;
        uint256 net = pot - bounty;

        (uint64[] memory times, uint256 n, uint256 sumW) = _winners(id, g);
        if (bounty > 0) sqk.safeTransfer(msg.sender, bounty);
        if (n == 0) {
            rolloverPool += net;
            g.status = Status.RolledOver;
            emit RolledOver(id, net, msg.sender);
            return;
        }

        uint256 jackpotCount = _setJackpot(g, times, n, net);
        g.sumWeights = sumW;
        g.status = Status.Settled;
        emit Settled(id, pot, bounty, n, jackpotCount, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function getGame(uint256 id) external view returns (Game memory) {
        return games[id];
    }

    function getPlayers(uint256 id) external view returns (address[] memory) {
        return players[id];
    }

    function getExitOrder(uint256 id) external view returns (address[] memory) {
        return exitOrder[id];
    }

    /// @notice What `player` can claim from game `id` right now.
    function claimable(uint256 id, address player) public view returns (uint256) {
        Game storage g = games[id];
        Entry storage e = entries[id][player];
        if (!e.entered || e.left || e.claimed) return 0;
        if (g.status == Status.Voided) return g.p.buyIn;
        bool started = g.status >= Status.Live;
        // Late entries and exits before the start are refunded.
        if (started && (e.enteredAt > g.startTime || (e.exitTime != 0 && e.exitTime < g.startTime))) return g.p.buyIn;
        if (g.status != Status.Settled) return 0;
        if (e.exitTime == 0 || e.exitTime > uint256(g.lastMove) + g.p.grace) return 0; // caught
        uint256 amount = (g.curvePool * weight(g, e.exitTime)) / g.sumWeights;
        if (e.exitTime >= g.jackpotFromTime) amount += g.jackpotEach;
        return amount;
    }

    /// @notice Weight of an exit: the seconds the player stayed on the wheel (at least 1), so each winner's
    /// share of the curve pool is in proportion to their time on the wheel.
    function weight(Game storage g, uint64 exitTime) internal view returns (uint256) {
        uint256 s = exitTime > g.startTime ? exitTime - g.startTime : 0;
        return s == 0 ? 1 : s;
    }

    function weightAt(uint256 id, uint64 exitTime) external view returns (uint256) {
        return weight(games[id], exitTime);
    }

    // ------------------------------------------------------------------ internal

    function _validate(Params memory p) internal pure {
        if (
            p.buyIn == 0 || p.idleWindow == 0 || p.jackpotBps > 10_000 || p.jackpotGroupBps > 10_000
                || p.minPlayers == 0 || p.maxPlayers < p.minPlayers
        ) revert BadParams();
    }

    function _create(Params memory p) internal returns (uint256 id) {
        _validate(p);
        id = ++gameCount;
        Game storage g = games[id];
        g.p = p;
        g.status = Status.Lobby;
        g.rolloverIn = rolloverPool;
        rolloverPool = 0;
        emit GameCreated(id, p, g.rolloverIn);
    }

    /// @dev Players in the pot: entered by the start, didn't leave, and didn't exit before the start.
    function _inAtStart(uint256 id, Game storage g) internal view returns (uint256 n) {
        address[] storage ps = players[id];
        for (uint256 i = 0; i < ps.length; i++) {
            Entry storage e = entries[id][ps[i]];
            if (e.left || e.enteredAt > g.startTime) continue;
            if (e.exitTime != 0 && e.exitTime < g.startTime) continue;
            n++;
        }
    }

    /// @dev Winners' exit times in exit order: in-game exits up to the grace cutoff, skipping late entries.
    function _winners(uint256 id, Game storage g) internal view returns (uint64[] memory times, uint256 n, uint256 sumW) {
        address[] storage order = exitOrder[id];
        times = new uint64[](order.length);
        uint256 cutoff = uint256(g.lastMove) + g.p.grace;
        for (uint256 i = 0; i < order.length; i++) {
            Entry storage e = entries[id][order[i]];
            if (e.enteredAt > g.startTime || e.exitTime < g.startTime) continue;
            if (e.exitTime > cutoff) break; // exits are in time order, so everyone after is caught too
            times[n++] = e.exitTime;
            sumW += weight(g, e.exitTime);
        }
    }

    /// @dev The jackpot goes to the last `jackpotGroupBps` of winners (at least one), plus anyone tied with
    /// the earliest of them. Sets the curve pool and the per-winner jackpot.
    function _setJackpot(Game storage g, uint64[] memory times, uint256 n, uint256 net) internal returns (uint256 count) {
        uint256 groupSize = (n * g.p.jackpotGroupBps + 5_000) / 10_000;
        if (groupSize == 0) groupSize = 1;
        uint64 fromTime = times[n - groupSize];
        for (uint256 i = n; i > 0 && times[i - 1] >= fromTime; i--) count++;
        uint256 jackpotPool = (net * g.p.jackpotBps) / 10_000;
        g.curvePool = net - jackpotPool;
        g.jackpotEach = jackpotPool / count;
        g.jackpotFromTime = fromTime;
    }

    function _void(uint256 id, Game storage g, string memory reason) internal {
        g.status = Status.Voided;
        rolloverPool += g.rolloverIn; // carried-in pot goes back to the pool for the next game
        g.rolloverIn = 0;
        emit Voided(id, reason);
    }

    /// @return 1 if settled rounds agree with the posted end, -1 if they contradict it, 0 if not settled yet.
    /// The counter at the last movement must lie between the settled totals before and after its round.
    function _roundCheck(Game storage g) internal view returns (int8) {
        uint64 r = (g.lastMove - coreGenesis) / coreRoundDuration + 1;
        if (squeekCore.state().settledThroughRound < r) return 0;
        uint64 before = squeekCore.roundPage(r - 1, r - 1, 0).end.cumulativeWork;
        uint64 afterRound = squeekCore.roundPage(r, r, 0).end.cumulativeWork;
        return (g.endCounter >= before && g.endCounter <= afterRound) ? int8(1) : int8(-1);
    }
}
