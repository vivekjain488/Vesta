// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {PerpetuaVault} from "../src/PerpetuaVault.sol";
import {RiskGate} from "../src/RiskGate.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {HarvestRouter} from "../src/HarvestRouter.sol";
import {ComputeTreasury} from "../src/ComputeTreasury.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLending} from "../src/mocks/MockLending.sol";
import {MockCCIPRouter} from "../src/mocks/MockCCIPRouter.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";

/// @notice Shared fixture: P = 1000 USDC, pi = 95%, R = 10 USDC, m = 3, E_max = 250 USDC
///         (the spec's worked example), wired end to end with a local CCIP simulator.
abstract contract BaseTest is Test {
    bytes32 internal constant AGENT_ID = keccak256("atlas");
    uint64 internal constant LOCAL_SELECTOR = 16015286601757825753; // any value; mock router
    uint64 internal constant OG_SELECTOR = 2131427466778448014; // placeholder 0G selector for tests

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");
    address internal flashSpender = makeAddr("flashAllowance");
    address internal operator = makeAddr("agentOperator");

    uint256 internal proposerPk = 0xA11CE;
    uint256 internal pricePk = 0xB0B;
    uint256 internal teePk = 0x7EE;
    address internal proposer;
    address internal priceSigner;
    address internal teeSigner;

    MockERC20 internal usdc;
    MockERC20 internal link;
    MockERC20 internal zeroG;
    MockLending internal lending;
    PerpetuaVault internal vault;
    AgentWallet internal wallet;
    RiskGate internal gate;
    MockCCIPRouter internal ccip;
    MockSwapAdapter internal swap;
    HarvestRouter internal router;
    ComputeTreasury internal treasury;

    uint256 internal constant LINK_PRICE = 15e8; // $15.00

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        proposer = vm.addr(proposerPk);
        priceSigner = vm.addr(pricePk);
        teeSigner = vm.addr(teePk);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        link = new MockERC20("Chainlink", "LINK", 18);
        zeroG = new MockERC20("0G", "0G", 18);

        vm.startPrank(owner);
        lending = new MockLending(address(usdc), 450, owner);
        vault = new PerpetuaVault(usdc, "Perpetua Atlas", "pATLAS", AGENT_ID, 9_500, 10e6, false, owner);
        wallet = new AgentWallet(owner);
        gate = new RiskGate(address(vault), address(wallet), 250e6, 1, proposer, priceSigner, owner);
        ccip = new MockCCIPRouter(LOCAL_SELECTOR);
        swap = new MockSwapAdapter(owner);
        router = new HarvestRouter(address(ccip), address(usdc), owner);
        treasury = new ComputeTreasury(address(ccip), address(zeroG), owner);

        wallet.wire(address(vault), address(gate), proposer, flashSpender);
        vault.wire(address(lending), address(gate), address(wallet), address(router));
        gate.setAsset(address(link), true, 500); // 5% daily vol
        gate.setTeeSigner(teeSigner, true);
        gate.setKeeperEconomics(0.05e6, 50e6, 1e6, 4 hours);

        // 1 USDC (1e6) -> 2 0G (2e18): rate is out per 1e18 in => 2e18 * 1e18 / 1e6
        swap.setRate(address(usdc), address(zeroG), 2e30);
        router.configure(address(zeroG), address(swap), OG_SELECTOR, address(treasury), 100, 300_000);
        router.setVault(address(vault), true);
        treasury.setAllowedSender(LOCAL_SELECTOR, address(router), true);
        treasury.configureAgent(AGENT_ID, operator, 1_000e18);
        vm.stopPrank();

        // disclosed one-time seeds: swap liquidity, lending yield reserve, CCIP gas
        zeroG.mint(address(swap), 1_000_000e18);
        usdc.mint(address(this), 10_000e6);
        usdc.approve(address(lending), type(uint256).max);
        lending.fundReserve(1_000e6);
        vm.deal(address(router), 1 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _deposit(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _price(address asset, uint256 priceE8) internal view returns (RiskGate.PriceAttestation memory p) {
        uint64 ts = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pricePk, gate.priceDigest(asset, priceE8, ts));
        p = RiskGate.PriceAttestation(asset, priceE8, ts, abi.encodePacked(r, s, v));
    }

    function _prices(address asset, uint256 priceE8) internal view returns (RiskGate.PriceAttestation[] memory ps) {
        ps = new RiskGate.PriceAttestation[](1);
        ps[0] = _price(asset, priceE8);
    }

    function _noPrices() internal pure returns (RiskGate.PriceAttestation[] memory ps) {
        ps = new RiskGate.PriceAttestation[](0);
    }

    function _tee(string memory text) internal view returns (RiskGate.TeeProof memory p) {
        bytes memory b = bytes(text);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePk, MessageHashUtils.toEthSignedMessageHash(b));
        p = RiskGate.TeeProof(keccak256("chat-1"), b, abi.encodePacked(r, s, v));
    }

    function _entry(bytes32 digest, uint256 amountIn, uint256 stopE8) internal view returns (RiskGate.OrderIntent memory o) {
        // minAmountOut at the attested price (18-dec LINK): amountIn(6dp) * 1e20 / priceE8
        uint256 minOut = (amountIn * 1e20) / LINK_PRICE;
        o = RiskGate.OrderIntent({
            flashDigest: digest,
            bracketDigest: bytes32(0),
            kind: RiskGate.Kind.Entry,
            tokenIn: address(usdc),
            tokenOut: address(link),
            amountIn: amountIn,
            minAmountOut: minOut,
            stopPriceE8: stopE8,
            takeProfitPriceE8: LINK_PRICE * 116 / 100,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: address(wallet)
        });
    }

    function _sigBy(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mandate() internal view returns (uint256 V, uint256 F, uint256 C, uint256 E) {
        (,,, V, F, C, E,,) = gate.mandate();
    }
}
