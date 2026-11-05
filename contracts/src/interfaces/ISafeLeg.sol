// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A liquid lending venue that holds the vault's floor. Liquid by design: depositors can always
///         withdraw at no less than the protected amount, so there is no fixed maturity.
interface ISafeLeg {
    function asset() external view returns (address);

    /// @notice Pull `amount` of asset from msg.sender and lend it.
    function deposit(uint256 amount) external;

    /// @notice Withdraw up to `amount` of asset to msg.sender. Returns the amount actually withdrawn.
    function withdraw(uint256 amount) external returns (uint256);

    /// @notice Current value (principal + accrued interest) attributable to msg.sender's position,
    ///         reported for `account`.
    function totalValue(address account) external view returns (uint256);
}
