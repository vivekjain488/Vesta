// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHarvestRouter {
    /// @notice Swap `amount` of the vault asset (already transferred in) into 0G CCT and send it to the
    ///         ComputeTreasury on 0G Chain via Chainlink CCIP. Returns the CCIP message id.
    function route(bytes32 agentId, uint256 amount, uint64 epoch) external returns (bytes32 messageId);
}

interface ISwapAdapter {
    /// @notice Swap exact `amountIn` of `tokenIn` (pulled from msg.sender) for `tokenOut`, sent to msg.sender.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut);

    /// @notice Expected output for `amountIn`, used to derive a minAmountOut with slippage.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
}
