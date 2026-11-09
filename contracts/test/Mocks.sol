// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISqueekCore} from "../ISqueekCore.sol";
import {SqueekChicken} from "../SqueekChicken.sol";

/// @notice Stand-in for SQK in tests: a plain ERC-20 with permit, like the real token.
contract MockSQK is ERC20, ERC20Permit {
    constructor() ERC20("Squeek", "SQK") ERC20Permit("Squeek") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Stand-in for SqueekCore in tests: the frontier and per-round cumulative work are set directly.
contract MockSqueekCore {
    uint64 public settledThroughRound;
    uint64 public genesis;
    mapping(uint64 => uint64) public workAfter; // cumulative work after each round

    constructor(uint64 genesis_) {
        genesis = genesis_;
    }

    function setSettled(uint64 r) external {
        settledThroughRound = r;
    }

    function setWorkAfter(uint64 r, uint64 w) external {
        workAfter[r] = w;
    }

    function state() external view returns (ISqueekCore.CoreState memory s) {
        s.settledThroughRound = settledThroughRound;
    }

    function configuration() external view returns (ISqueekCore.CoreConfiguration memory c) {
        c.genesisTimestamp = genesis;
        c.roundDuration = 600;
    }

    function roundPage(uint64, uint64 throughRound, uint256) external view returns (ISqueekCore.RoundPage memory p) {
        p.certifiedThroughRound = throughRound;
        p.end.cumulativeWork = workAfter[throughRound];
    }
}

/// @notice A stand-in next version of the game, for upgrade tests: same storage, one new function.
/// @custom:oz-upgrades-from SqueekChicken
contract SqueekChickenV2Mock is SqueekChicken {
    function version() public pure override returns (string memory) {
        return "next";
    }
}

/// @notice Stand-in Squeek NFT for tests.
contract MockNFT is ERC721 {
    uint256 public constant MAX_SUPPLY = 200;

    mapping(uint256 => uint8) public levelOf; // 0 means level 1

    constructor() ERC721("Squeek", "SQUEEK") {}

    function level(uint256 tokenId) external view returns (uint8) {
        ownerOf(tokenId); // reverts for a burned or unissued Squeek, like the real one
        return levelOf[tokenId] + 1;
    }

    /// @notice Test helper for merges: burns `donor` and raises `survivor` a level; the caller must own both.
    function mergeBurn(uint256 survivor, uint256 donor) external {
        require(ownerOf(survivor) == msg.sender && ownerOf(donor) == msg.sender && survivor != donor, "not owner");
        require(levelOf[survivor] == levelOf[donor], "level mismatch");
        _burn(donor);
        levelOf[survivor] += 1;
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice Stand-in for SqueekStaking in tests: holds deposited NFTs and pays rewards that the test feeds
/// in with `accrue`, standing in for Squeekchain's reward stream. Like the real contract, only the account
/// itself can claim, and `depositor` says who staked a token.
contract MockStaking {
    IERC20 public immutable token;
    address public genesis;
    address public clones;
    mapping(address => uint256) public owed;
    mapping(address => mapping(uint256 => address)) public depositor;
    mapping(address => uint256) public power;

    mapping(address => uint256) public principal;
    bool public paused;

    error Unauthorized();
    error EmergencyPaused();

    constructor(IERC20 token_, address genesis_) {
        token = token_;
        genesis = genesis_;
    }

    function setClones(address clones_) external {
        clones = clones_;
    }

    function deposit(address collection, uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            IERC721(collection).transferFrom(msg.sender, address(this), tokenIds[i]);
            depositor[collection][tokenIds[i]] = msg.sender;
            power[msg.sender] += 1000e18;
        }
    }

    function withdraw(address collection, uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (depositor[collection][tokenIds[i]] != msg.sender) revert Unauthorized();
            delete depositor[collection][tokenIds[i]];
            power[msg.sender] -= 1000e18;
            IERC721(collection).transferFrom(address(this), msg.sender, tokenIds[i]);
        }
    }

    function setPaused(bool p) external {
        paused = p;
    }

    /// @dev Merges two of the caller's deposited Squeeks; power rises by 10% of the pair at level 1 to 2.
    function mergeDeposited(address collection, uint256 survivor, uint256 donor) external {
        if (paused) revert EmergencyPaused();
        if (depositor[collection][survivor] != msg.sender || depositor[collection][donor] != msg.sender) revert Unauthorized();
        MockNFT(collection).mergeBurn(survivor, donor);
        delete depositor[collection][donor];
        power[msg.sender] += 200e18;
    }

    function stake(uint256 amount) external {
        if (paused) revert EmergencyPaused();
        token.transferFrom(msg.sender, address(this), amount);
        principal[msg.sender] += amount;
    }

    /// @dev Burns a flat 2% exit fee (sent to a dead address here).
    function unstake(uint256 amount, uint256 maxFee, uint64 deadline) external returns (uint256 net) {
        require(block.timestamp <= deadline, "deadline");
        uint256 fee = amount / 50;
        require(fee <= maxFee, "fee");
        principal[msg.sender] -= amount;
        net = amount - fee;
        token.transfer(address(0xdead), fee);
        token.transfer(msg.sender, net);
    }

    function quoteUnstake(address, uint256 amount) external pure returns (uint256 fee, uint256 net) {
        fee = amount / 50;
        net = amount - fee;
    }

    function stakeOf(address account) external view returns (uint256, uint256, uint64) {
        return (principal[account], 0, 0);
    }

    /// @notice Test helper: credits `account` with `amount` of rewards, paid in by the caller.
    function accrue(address account, uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        owed[account] += amount;
    }

    function claimable(address account) external view returns (uint256) {
        return owed[account];
    }

    function claim(address account) external returns (uint256 amount) {
        if (msg.sender != account) revert Unauthorized();
        amount = owed[account];
        owed[account] = 0;
        token.transfer(account, amount);
    }

    function accountPower(address account) external view returns (uint256 nftPower, uint256 sqkPower) {
        return (power[account], 0);
    }
}
