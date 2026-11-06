// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRiskGate {
    function isApproved(bytes32 digest) external view returns (bool);

    /// @notice Last marked value (USDC units) of everything held by the AgentWallet.
    function walletValue() external view returns (uint256);

    /// @notice Vault-only hook: refresh entry permissions and sleep if remaining owner capital is too low.
    function onOwnerWithdrawal() external;
}
