// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CPPIMath} from "../src/libraries/CPPIMath.sol";

contract CPPIMathTest is Test {
    /// Spec worked example: P=1000, pi=95%, R=10 -> F=960, C=40, E=120.
    function test_workedExample_dayOne() public pure {
        uint256 F = CPPIMath.floorValue(1000e6, 9_500, 10e6);
        assertEq(F, 960e6);
        uint256 C = CPPIMath.cushion(1000e6, F);
        assertEq(C, 40e6);
        assertEq(CPPIMath.exposureBudget(C, 3, 250e6), 120e6);
    }

    /// After a month of ~$43 net service income: C ~ 83, E capped at E_max = 250.
    function test_workedExample_afterOneMonth() public pure {
        uint256 F = CPPIMath.floorValue(1000e6, 9_500, 10e6);
        uint256 C = CPPIMath.cushion(1043e6, F);
        assertEq(C, 83e6);
        assertEq(CPPIMath.exposureBudget(C, 3, 250e6), 249e6);
        assertEq(CPPIMath.exposureBudget(C + 1e6, 3, 250e6), 250e6);
    }

    /// Position sizing example: $5 risk at an 8% stop -> $62.50.
    function test_positionSize() public pure {
        assertEq(CPPIMath.positionSize(5e6, 800), 62.5e6);
    }

    /// VaR example: E=$150 at 5% daily vol -> ~$12.4.
    function test_var() public pure {
        assertEq(CPPIMath.valueAtRisk(150e6, 500), 12.375e6);
    }

    function test_stopInsideGap() public pure {
        assertTrue(CPPIMath.stopInsideGap(100e8, 92e8, 3)); // 8% stop, gap 33%
        assertFalse(CPPIMath.stopInsideGap(100e8, 66e8, 3)); // 34% stop > 1/3
        assertFalse(CPPIMath.stopInsideGap(100e8, 0, 3)); // missing stop
        assertFalse(CPPIMath.stopInsideGap(100e8, 101e8, 3)); // stop above entry
    }

    function test_usdcValue() public pure {
        assertEq(CPPIMath.usdcValue(2e18, 18, 15e8), 30e6); // 2 LINK @ $15
        assertEq(CPPIMath.usdcValue(1e8, 8, 60_000e8), 60_000e6); // 1 cbBTC
    }

    function testFuzz_exposureBounds(uint128 v, uint128 p, uint16 pi, uint64 r, uint8 m, uint128 eMax) public pure {
        uint256 piBps = bound(pi, 5_000, 10_000);
        uint256 mm = bound(m, 1, 4);
        uint256 F = CPPIMath.floorValue(p, piBps, r);
        uint256 C = CPPIMath.cushion(v, F);
        uint256 E = CPPIMath.exposureBudget(C, mm, eMax);
        assertLe(E, C * mm);
        assertLe(E, eMax);
        if (v <= F) assertEq(E, 0);
        // A loss bounded by the stop distance (< 1/m of exposure) can never take V below F.
        uint256 maxStopLoss = E / mm;
        assertGe(uint256(v) - (v > F ? maxStopLoss : 0), v > F ? F : 0);
    }

    function testFuzz_floorMonotonic(uint128 p, uint16 pi, uint64 r) public pure {
        uint256 piBps = bound(pi, 0, 10_000);
        assertGe(CPPIMath.floorValue(p, piBps, r), r);
        assertLe(CPPIMath.floorValue(p, piBps, r), uint256(p) + r);
    }
}
