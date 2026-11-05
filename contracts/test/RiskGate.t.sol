// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {RiskGate} from "../src/RiskGate.sol";

contract RiskGateTest is BaseTest {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    string internal constant REASONING =
        '{"action":"BUY","asset":"LINK","size_usdc":50,"stop":13.80,"target":17.40,"confidence":0.62}';

    function setUp() public override {
        super.setUp();
        _deposit(alice, 1_000e6);
    }

    function _approve(RiskGate.OrderIntent memory o) internal {
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory proof = _tee(REASONING);
        vm.prank(proposer);
        gate.approveOrder(o, px, proof);
    }

    // ------------------------------------------------------------ poke / mandate

    function test_poke_reproducesWorkedExample() public {
        vm.prank(keeper);
        assertTrue(gate.poke(_noPrices()));
        (uint256 V, uint256 F, uint256 C, uint256 E) = _mandate();
        assertEq(V, 1_000e6);
        assertEq(F, 960e6);
        assertEq(C, 40e6);
        assertEq(E, 120e6);
        // wallet cap: the wallet is topped up to exactly E
        assertEq(usdc.balanceOf(address(wallet)), 120e6);
        // keeper paid its bounty
        assertEq(usdc.balanceOf(keeper), 0.05e6);
        // NAV still counts the funded wallet
        assertApproxEqAbs(vault.totalAssets(), 1_000e6 - 0.05e6, 1);
    }

    function test_poke_idempotentWithinInterval() public {
        vm.prank(keeper);
        gate.poke(_noPrices());
        vm.prank(keeper);
        assertFalse(gate.poke(_noPrices()), "second poke must be a no-op");
        assertEq(usdc.balanceOf(keeper), 0.05e6, "no double bounty");
    }

    function test_poke_bountyOncePerInterval() public {
        vm.prank(keeper);
        gate.poke(_noPrices());
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        gate.poke(_noPrices()); // state changed (yield accrued) -> refresh, but no bounty yet
        assertEq(usdc.balanceOf(keeper), 0.05e6);
        vm.warp(block.timestamp + 4 hours);
        vm.prank(keeper);
        gate.poke(_noPrices());
        assertEq(usdc.balanceOf(keeper), 0.10e6);
    }

    // ------------------------------------------------------------ the safety proof

    function test_recklessTrade_rejectedOnChain() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("reckless"), 500e6, 13.8e8); // > E = 120
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory proof = _tee(REASONING);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Rejected.selector, bytes32("EXCEEDS_EXPOSURE")));
        gate.approveOrder(o, px, proof);
        // ...and the wallet refuses to sign it
        assertTrue(wallet.isValidSignature(o.flashDigest, _sigBy(proposerPk, o.flashDigest)) != MAGIC);
    }

    function test_rejects_missingStop() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("nostop"), 50e6, 0);
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("NO_STOP"));
    }

    function test_rejects_stopOutsideGap() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("widestop"), 50e6, 9e8); // 40% stop > 1/3
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("STOP_OUTSIDE_GAP"));
    }

    function test_rejects_redirectedRecipient() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("redirect"), 50e6, 13.8e8);
        o.recipient = makeAddr("attacker");
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("RECIPIENT_NOT_WALLET"));
    }

    function test_rejects_stalePrice() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("stale"), 50e6, 13.8e8);
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        vm.warp(block.timestamp + 61);
        assertEq(gate.checkOrder(o, px), bytes32("PRICE_STALE"));
    }

    function test_rejects_fakedOrderPrice() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("fakeprice"), 50e6, 13.8e8);
        o.minAmountOut = o.minAmountOut / 2; // agent tries to accept a terrible fill
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("PRICE_DEVIATION"));
    }

    function test_rejects_forgedTeeProof() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("forged"), 50e6, 13.8e8);
        RiskGate.TeeProof memory p = _tee(REASONING);
        p.response = bytes('{"action":"BUY","asset":"LINK","size_usdc":5000}'); // tampered output
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Rejected.selector, bytes32("TEE_PROOF_INVALID")));
        gate.approveOrder(o, px, p);
    }

    function test_onlyProposerCanPropose() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("x"), 50e6, 13.8e8);
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory p = _tee(REASONING);
        vm.prank(alice);
        vm.expectRevert(RiskGate.OnlyProposer.selector);
        gate.approveOrder(o, px, p);
    }

    // ------------------------------------------------------------ approved path + EIP-1271

    function test_validOrder_approved_and1271Signs() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("good"), 50e6, 13.8e8);
        o.bracketDigest = keccak256("good-bracket");
        _approve(o);

        assertEq(wallet.isValidSignature(o.flashDigest, _sigBy(proposerPk, o.flashDigest)), MAGIC);
        assertEq(wallet.isValidSignature(o.bracketDigest, _sigBy(proposerPk, o.bracketDigest)), MAGIC);
        // wrong signer or unapproved digest -> invalid
        assertTrue(wallet.isValidSignature(o.flashDigest, _sigBy(0xBAD, o.flashDigest)) != MAGIC);
        bytes32 other = keccak256("other");
        assertTrue(wallet.isValidSignature(other, _sigBy(proposerPk, other)) != MAGIC);
        // allowance raised only by amountIn (fallback cap)
        assertEq(usdc.allowance(address(wallet), flashSpender), 50e6);
        // duplicate approval refused
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("ALREADY_APPROVED"));
    }

    function test_sharedExposureBudget_acrossOrders() public {
        gate.poke(_noPrices());
        _approve(_entry(keccak256("a"), 70e6, 13.8e8));
        RiskGate.OrderIntent memory b = _entry(keccak256("b"), 60e6, 13.8e8);
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory proof = _tee(REASONING);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Rejected.selector, bytes32("EXCEEDS_EXPOSURE")));
        gate.approveOrder(b, px, proof);
    }

    function test_entryApprovalDiesWithMandate_exitSurvives() public {
        gate.poke(_noPrices());
        RiskGate.OrderIntent memory o = _entry(keccak256("e"), 50e6, 13.8e8);
        o.bracketDigest = keccak256("e-bracket");
        _approve(o);
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_noPrices()); // new epoch
        assertFalse(gate.isApproved(o.flashDigest), "entry must not outlive its mandate");
        assertTrue(gate.isApproved(o.bracketDigest), "protective bracket must stay live");
    }

    function test_mandateExpiry_refusesOrders() public {
        gate.poke(_noPrices());
        vm.warp(block.timestamp + 5 hours); // keeper down: approval window lapsed
        RiskGate.OrderIntent memory o = _entry(keccak256("late"), 50e6, 13.8e8);
        o.deadline = uint64(block.timestamp + 10 minutes);
        assertEq(gate.checkOrder(o, _price(address(link), LINK_PRICE)), bytes32("MANDATE_STALE"));
    }

    // ------------------------------------------------------------ hibernation + breakers

    function test_stalePriceOnHeldAsset_hibernates() public {
        gate.poke(_noPrices());
        // simulate a filled entry: wallet now holds LINK
        link.mint(address(wallet), 3e18);
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_noPrices()); // no fresh price for a held asset
        assertTrue(gate.hibernating());
        (,,, uint256 E) = _mandate();
        assertEq(E, 0);
        assertEq(usdc.balanceOf(address(wallet)), 0, "stablecoin pulled back to the vault");

        // fresh price + time -> wakes up
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_prices(address(link), LINK_PRICE));
        assertFalse(gate.hibernating());
    }

    function test_drawdownBreaker_tradingOff() public {
        gate.poke(_noPrices());
        // a 35-USDC loss inside the wallet (within the 1/m gap) -> cushion 40 -> ~5
        usdc.burn(address(wallet), 35e6);
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_noPrices());
        assertTrue(gate.tradingOff() || gate.haltedUntil() > block.timestamp);
        (,,, uint256 E) = _mandate();
        assertEq(E, 0);
        // floor intact
        (uint256 V, uint256 F,,) = _mandate();
        assertGe(V, F);
    }

    function test_flashCancelMessage_signableWithoutGateApproval() public {
        string memory orderId = "3f2b8c1e-0000-4000-8000-000000000001";
        bytes32 h = wallet.cancelHash(orderId);
        // matches viem/ethers hashMessage of the canonical text
        assertEq(h, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", "80", unicode"Definitive Flash v1 — Cancel Order\nOrder: ", orderId)));
        assertTrue(wallet.isValidSignature(h, _sigBy(proposerPk, h)) != MAGIC);
        vm.prank(proposer);
        wallet.approveCancel(orderId);
        assertEq(wallet.isValidSignature(h, _sigBy(proposerPk, h)), MAGIC);
        vm.prank(alice);
        vm.expectRevert(bytes("auth"));
        wallet.approveCancel("x");
    }

    function test_proposerCanOnlyTightenFlags() public {
        vm.prank(proposer);
        gate.setRuntimeFlags(true, true);
        vm.prank(proposer);
        vm.expectRevert(bytes("tighten only"));
        gate.setRuntimeFlags(false, true);
    }

    function test_previewMandate_isReplayable() public view {
        (uint256 F, uint256 C, uint256 E) = gate.previewMandate(1_000e6, 1_000e6, 9_500, 10e6, 3, 250e6);
        assertEq(F, 960e6);
        assertEq(C, 40e6);
        assertEq(E, 120e6);
    }
}
