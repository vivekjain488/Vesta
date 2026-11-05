// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISwapAdapter} from "../interfaces/IHarvestRouter.sol";

/// @notice Fixed-rate swap venue for testnets (USDC -> 0G). Holds pre-funded tokenOut liquidity, seeded once
///         and disclosed. On mainnet, replace with a Flash-routed or Uniswap/KyberSwap adapter.
contract MockSwapAdapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    /// @dev rate[tokenIn][tokenOut] = amountOut per 1e18 amountIn (raw units).
    mapping(address => mapping(address => uint256)) public rate;

    constructor(address owner_) Ownable(owner_) {}

    function setRate(address tokenIn, address tokenOut, uint256 outPer1e18In) external onlyOwner {
        rate[tokenIn][tokenOut] = outPer1e18In;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        return (amountIn * rate[tokenIn][tokenOut]) / 1e18;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut)
    {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        require(amountOut > 0 && amountOut >= minAmountOut, "slippage");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
