// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRiskGate {
    function isApproved(bytes32 digest) external view returns (bool);

    /// @notice Last marked value (USDC units) of everything held by the AgentWallet.
    function walletValue() external view returns (uint256);
}
