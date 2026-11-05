// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentWallet {
    /// @notice Send `amount` of `token` back to the vault. Callable by the vault only.
    function returnToVault(address token, uint256 amount) external returns (uint256 sent);

    /// @notice Raise the wallet's ERC-20 allowance to Flash's allowance contract, capped. RiskGate only.
    function grantFlashAllowance(address token, uint256 amount, uint256 cap) external;

    /// @notice Zero every allowance (hibernation). RiskGate only.
    function revokeFlashAllowance(address token) external;
}
