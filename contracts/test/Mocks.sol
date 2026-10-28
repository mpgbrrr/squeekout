// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISqueekCore} from "../ISqueekCore.sol";

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

/// @notice Stand-in Squeek NFT for tests.
contract MockNFT is ERC721 {
    constructor() ERC721("Squeek", "SQUEEK") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice Stand-in for SqueekStaking in tests: holds deposited NFTs and pays rewards that the test feeds
/// in with `accrue`, standing in for Squeekchain's reward stream. Like the real contract, only the account
/// itself can claim.
contract MockStaking {
    IERC20 public immutable token;
    mapping(address => uint256) public owed;
    mapping(address => mapping(uint256 => address)) public depositor;
    mapping(address => uint256) public power;

    error Unauthorized();

    constructor(IERC20 token_) {
        token = token_;
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
