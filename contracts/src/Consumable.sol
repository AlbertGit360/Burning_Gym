// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Whole prepaid plays that cannot leave their Friend's canonical wallet.
contract Consumable is ERC20 {
    address public immutable game;

    error OnlyGame();
    error FriendBoundInventory();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        game = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address account, uint256 quantity) external {
        if (msg.sender != game) revert OnlyGame();
        _mint(account, quantity);
    }

    function controllerBurn(address account, uint256 quantity) external {
        if (msg.sender != game) revert OnlyGame();
        _burn(account, quantity);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert FriendBoundInventory();
        super._update(from, to, value);
    }
}
