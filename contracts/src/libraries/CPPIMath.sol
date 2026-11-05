// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CPPIMath
/// @notice Pure, deterministic Endowment-CPPI arithmetic. Every number RiskGate publishes (F, C, E, VaR)
///         is derived here, so anyone can replay it from on-chain state with a single eth_call.
/// @dev    Units: all money values are in the vault asset's smallest unit (USDC = 6 decimals).
///         Ratios are basis points (1e4 = 100%). Prices are USD with 8 decimals (E8).
library CPPIMath {
    uint256 internal constant BPS = 10_000;
    /// @dev 1.65 = one-sided 95% z-score, expressed as 165 / 100.
    uint256 internal constant VAR_Z_X100 = 165;

    /// @notice F = pi * P + R
    function floorValue(uint256 principal, uint256 piBps, uint256 reserve) internal pure returns (uint256) {
        return (principal * piBps) / BPS + reserve;
    }

    /// @notice C = max(V - F, 0)
    function cushion(uint256 value, uint256 floor_) internal pure returns (uint256) {
        return value > floor_ ? value - floor_ : 0;
    }

    /// @notice E = min(m * C, E_max)
    function exposureBudget(uint256 cushion_, uint256 m, uint256 eMax) internal pure returns (uint256) {
        uint256 e = cushion_ * m;
        return e < eMax ? e : eMax;
    }

    /// @notice 1-day parametric VaR = 1.65 * dailyVol * exposure
    function valueAtRisk(uint256 exposure, uint256 dailyVolBps) internal pure returns (uint256) {
        return (exposure * dailyVolBps * VAR_Z_X100) / (BPS * 100);
    }

    /// @notice True when the stop sits below entry and the stop distance is strictly inside the CPPI gap
    ///         tolerance 1/m. A stop wider than 1/m means a single stop-out could breach the floor.
    function stopInsideGap(uint256 entryPriceE8, uint256 stopPriceE8, uint256 m) internal pure returns (bool) {
        if (stopPriceE8 == 0 || stopPriceE8 >= entryPriceE8 || m == 0) return false;
        return (entryPriceE8 - stopPriceE8) * m < entryPriceE8;
    }

    /// @notice Position size from a fixed dollar risk and a stop distance.
    ///         size = riskPerTrade / stopDistance. Example: $5 risk / 8% stop = $62.50.
    function positionSize(uint256 riskPerTrade, uint256 stopDistanceBps) internal pure returns (uint256) {
        if (stopDistanceBps == 0) return 0;
        return (riskPerTrade * BPS) / stopDistanceBps;
    }

    /// @notice USD value (in 6-decimal USDC units) of `amount` of a token with `decimals`, at `priceE8`.
    function usdcValue(uint256 amount, uint8 decimals, uint256 priceE8) internal pure returns (uint256) {
        // amount * priceE8 / 10^decimals gives USD*1e8; USDC has 6 decimals -> divide by 1e2 more.
        return (amount * priceE8) / (10 ** (uint256(decimals) + 2));
    }

    /// @notice Absolute deviation of `a` from reference `b`, in bps of `b`.
    function deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * BPS) / b;
    }
}
