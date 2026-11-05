// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISafeLeg} from "../interfaces/ISafeLeg.sol";

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @title AaveV3Adapter
/// @notice Mainnet / fork safe leg: lends the floor on Aave v3 (e.g. USDC on Base). Liquid at all times subject
///         to Aave utilisation. Only the bound vault can move funds. Counterparty risk: Aave protocol risk is
///         stated openly in the README; principal protection holds against bad trades, not a lending hack.
contract AaveV3Adapter is ISafeLeg {
    using SafeERC20 for IERC20;

    IAaveV3Pool public immutable pool;
    IERC20 public immutable underlying;
    IERC20 public immutable aToken;
    address public immutable vault;

    error OnlyVault();

    constructor(address pool_, address underlying_, address aToken_, address vault_) {
        pool = IAaveV3Pool(pool_);
        underlying = IERC20(underlying_);
        aToken = IERC20(aToken_);
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    function deposit(uint256 amount) external onlyVault {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        underlying.forceApprove(address(pool), amount);
        pool.supply(address(underlying), amount, address(this), 0);
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 bal = aToken.balanceOf(address(this));
        uint256 amt = amount > bal ? bal : amount;
        if (amt == 0) return 0;
        return pool.withdraw(address(underlying), amt, msg.sender);
    }

    /// @dev aTokens rebase, so balanceOf already includes accrued interest.
    function totalValue(address) external view returns (uint256) {
        return aToken.balanceOf(address(this));
    }
}
