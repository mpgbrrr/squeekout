// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Free test token for playing SqueekChicken on Sepolia without real $SQK. It is not $SQK and has no
/// value: anyone can mint up to MAX_MINT per call.
contract TestSQK is ERC20, ERC20Permit {
    uint256 public constant MAX_MINT = 10_000 ether;

    error MintTooLarge();

    constructor() ERC20("Test Squeek", "tSQK") ERC20Permit("Test Squeek") {}

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, amount);
    }
}
