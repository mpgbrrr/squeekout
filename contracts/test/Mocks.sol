// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
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
