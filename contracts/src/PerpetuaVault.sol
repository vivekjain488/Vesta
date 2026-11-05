// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ISafeLeg} from "./interfaces/ISafeLeg.sol";
import {IRiskGate} from "./interfaces/IRiskGate.sol";
import {IAgentWallet} from "./interfaces/IAgentWallet.sol";
import {IHarvestRouter} from "./interfaces/IHarvestRouter.sol";
import {CPPIMath} from "./libraries/CPPIMath.sol";

/// @title PerpetuaVault
/// @notice ERC-4626 Endowment-CPPI vault. Records principal P, protection level pi (locked at deploy) and
///         compute reserve R, so that F = pi*P + R. Only the cushion above F can ever leave the safe leg (that
///         rule is enforced by RiskGate, which is the only address allowed to move money out of here).
///
///         Accounting choice (kept consistent everywhere): management/performance fees are a LIABILITY
///         (`feeAccrued`) excluded from totalAssets. On harvest, fees pay the compute bill FIRST; any fee left
///         over after the bill becomes `ownerClaimable` for the agent owner. The vault's own income
///         (service income, safe-leg yield, realised PnL) that is not needed for compute stays in NAV.
contract PerpetuaVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_MGMT_FEE_BPS = 300; // hard cap even for the cost-plus repricer
    uint256 public constant MAX_PERF_FEE_BPS = 2_000;

    // ---------------------------------------------------------------- configuration
    bytes32 public immutable agentId;
    uint256 public immutable piBps; // protection level, locked at registration
    uint256 public immutable computeReserve; // R
    bool public immutable isFollowerVault; // Pillar 2 vaults are separate ledgers with their own RiskGate

    ISafeLeg public safeLeg;
    address public riskGate;
    address public agentWallet;
    address public harvestRouter;
    address public feeManager; // agent runtime: reprices mgmt fee cost-plus each cycle
    address public agentOwner; // receives ownerClaimable
    uint256 public idleBufferBps = 300;

    // ---------------------------------------------------------------- CPPI state
    uint256 public principal; // P
    uint256 public safeBasis; // principal lent to the safe leg (yield = value - basis)
    int256 public walletFundedNet; // funded - returned, to detect realised PnL

    // ---------------------------------------------------------------- income + fees
    uint256 public unharvestedIncome;
    mapping(bytes32 => uint256) public incomeByEngine;
    uint256 public totalHarvested;

    uint256 public managementFeeBps;
    uint256 public performanceFeeBps;
    uint256 public highWaterMark; // assets per 1e18 shares
    uint64 public lastFeeAccrual;
    uint256 public feeAccrued;
    uint256 public ownerClaimable;
    uint256 public computeNeedPerHarvest; // set cost-plus by feeManager, bounded by RiskGate's harvest cap

    // ---------------------------------------------------------------- events
    event Wired(address safeLeg, address riskGate, address agentWallet, address harvestRouter);
    event IncomeRecorded(bytes32 indexed engine, address indexed payer, uint256 amount);
    event WalletFunded(uint256 amount);
    event WalletPulled(uint256 amount, uint256 realisedProfit);
    event FeesAccrued(uint256 mgmt, uint256 perf);
    event Harvested(uint64 indexed epoch, uint256 fromFees, uint256 fromSurplus, uint256 toOwner, bytes32 ccipMessageId);
    event BountyPaid(address indexed keeper, uint256 amount);
    event FeeParamsSet(uint256 mgmtBps, uint256 perfBps, uint256 computeNeed);
    event OwnerClaimed(address indexed to, uint256 amount);

    error OnlyRiskGate();
    error OnlyFeeManager();
    error AlreadyWired();
    error Insolvent();
    error FeeTooHigh();

    modifier onlyRiskGate() {
        if (msg.sender != riskGate) revert OnlyRiskGate();
        _;
    }

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        bytes32 agentId_,
        uint256 piBps_,
        uint256 computeReserve_,
        bool isFollowerVault_,
        address owner_
    ) ERC20(name_, symbol_) ERC4626(asset_) Ownable(owner_) {
        require(piBps_ <= BPS && piBps_ >= 5_000, "pi");
        agentId = agentId_;
        piBps = piBps_;
        computeReserve = computeReserve_;
        isFollowerVault = isFollowerVault_;
        agentOwner = owner_;
        feeManager = owner_;
        lastFeeAccrual = uint64(block.timestamp);
    }

    /// @notice One-time wiring (deploy order: vault -> wallet -> riskGate -> router). Cannot be re-pointed,
    ///         so the gate that guards the floor can never be swapped out from under depositors.
    function wire(address safeLeg_, address riskGate_, address agentWallet_, address harvestRouter_)
        external
        onlyOwner
    {
        if (riskGate != address(0)) revert AlreadyWired();
        require(ISafeLeg(safeLeg_).asset() == asset(), "asset");
        safeLeg = ISafeLeg(safeLeg_);
        riskGate = riskGate_;
        agentWallet = agentWallet_;
        harvestRouter = harvestRouter_;
        IERC20(asset()).forceApprove(safeLeg_, type(uint256).max);
        emit Wired(safeLeg_, riskGate_, agentWallet_, harvestRouter_);
    }

    function setFeeManager(address fm) external onlyOwner {
        feeManager = fm;
    }

    function setAgentOwner(address o) external onlyOwner {
        agentOwner = o;
    }

    function setIdleBufferBps(uint256 b) external onlyOwner {
        require(b <= 2_000, "buf");
        idleBufferBps = b;
    }

    /// @notice Cost-plus repricing. fee_per_cycle = compute_cost_attributable * (1 + margin). The runtime
    ///         converts that into an annualised bps each cycle; the contract only enforces hard caps.
    function setFeeParams(uint256 mgmtBps, uint256 perfBps, uint256 computeNeed) external {
        if (msg.sender != feeManager) revert OnlyFeeManager();
        if (mgmtBps > MAX_MGMT_FEE_BPS || perfBps > MAX_PERF_FEE_BPS) revert FeeTooHigh();
        managementFeeBps = mgmtBps;
        performanceFeeBps = perfBps;
        computeNeedPerHarvest = computeNeed;
        emit FeeParamsSet(mgmtBps, perfBps, computeNeed);
    }

    // =================================================================== valuation

    function idle() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function safeValue() public view returns (uint256) {
        return address(safeLeg) == address(0) ? 0 : safeLeg.totalValue(address(this));
    }

    function walletValue() public view returns (uint256) {
        return riskGate == address(0) ? 0 : IRiskGate(riskGate).walletValue();
    }

    function liabilities() public view returns (uint256) {
        return feeAccrued + ownerClaimable;
    }

    /// @notice V excluding the agent wallet (the part RiskGate can read without a price).
    function vaultSideAssets() public view returns (uint256) {
        return _sub0(idle() + safeValue(), liabilities());
    }

    /// @notice V = idle + safe leg + marked agent wallet - fee liabilities.
    function totalAssets() public view override returns (uint256) {
        return _sub0(idle() + safeValue() + walletValue(), liabilities());
    }

    function floorValue() public view returns (uint256) {
        return CPPIMath.floorValue(principal, piBps, computeReserve);
    }

    function safeYield() public view returns (uint256) {
        return _sub0(safeValue(), safeBasis);
    }

    /// @notice Income not yet harvested: service income + realised PnL + safe-leg yield.
    function harvestableIncome() public view returns (uint256) {
        return unharvestedIncome + safeYield();
    }

    /// @notice Assets that can be made idle right now (idle + safe leg + wallet stablecoin - liabilities).
    function liquidAssets() public view returns (uint256) {
        return _sub0(idle() + safeValue() + IERC20(asset()).balanceOf(agentWallet), liabilities());
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), liquidAssets());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 shares = super.maxRedeem(owner_);
        uint256 liquid = liquidAssets();
        if (convertToAssets(shares) <= liquid) return shares;
        return convertToShares(liquid);
    }

    // =================================================================== ERC-4626 hooks

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        super._deposit(caller, receiver, assets, shares);
        principal += assets;
        if (highWaterMark == 0) highWaterMark = _pps();
        _deployIdle();
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        uint256 supply = totalSupply();
        // Floor shrinks pro-rata with the shares leaving.
        principal -= supply == 0 ? principal : principal.mulDiv(shares, supply);
        _ensureLiquid(assets + liabilities());
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // =================================================================== income

    /// @notice Any income engine pays in here (x402 revenue forwarder, keeper bounties earned on other vaults,
    ///         LP fees, copy-trade fees withdrawn from the Flash portfolio). Raises V and therefore the cushion,
    ///         never P.
    function recordIncome(bytes32 engine, uint256 amount) external nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        unharvestedIncome += amount;
        incomeByEngine[engine] += amount;
        emit IncomeRecorded(engine, msg.sender, amount);
    }

    // =================================================================== RiskGate-only money movement

    /// @notice Move cushion capital to the trading wallet (RiskGate sizes it so wallet <= E).
    function fundWallet(uint256 amount) external onlyRiskGate nonReentrant {
        _ensureLiquid(amount + liabilities());
        IERC20(asset()).safeTransfer(agentWallet, amount);
        walletFundedNet += int256(amount);
        emit WalletFunded(amount);
    }

    /// @notice Pull stablecoin back from the wallet (wallet above E, or hibernation).
    function pullFromWallet(uint256 amount) external onlyRiskGate nonReentrant returns (uint256 got) {
        got = _pullFromWallet(amount);
        _deployIdle();
    }

    /// @notice Owner emergency pull, e.g. if the keeper network is down; funds can only land back here.
    function emergencyPullFromWallet(uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        return _pullFromWallet(amount);
    }

    function accrueFees(uint256 cushionCap) external onlyRiskGate returns (uint256 fee) {
        uint256 dt = block.timestamp - lastFeeAccrual;
        lastFeeAccrual = uint64(block.timestamp);
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 ta = totalAssets();
        uint256 mgmt = (ta * managementFeeBps * dt) / (BPS * 365 days);
        uint256 perf;
        uint256 pps = _pps();
        if (pps > highWaterMark && highWaterMark != 0) {
            perf = ((pps - highWaterMark) * supply / 1e18) * performanceFeeBps / BPS;
        }
        fee = mgmt + perf;
        // Fees may only ever come out of the cushion: the floor is untouchable.
        if (fee > cushionCap) fee = cushionCap;
        if (fee > 0) feeAccrued += fee;
        uint256 newPps = _pps();
        if (newPps > highWaterMark) highWaterMark = newPps;
        emit FeesAccrued(mgmt, perf);
    }

    /// @notice Bills first, profit second. Fees pay the compute bill first; excess fees go to the owner;
    ///         any remaining bill is covered from the vault's own harvestable income, up to `maxFromSurplus`
    ///         (RiskGate bounds this by the cushion so V never drops below F).
    function harvest(uint256 maxFromSurplus, uint64 epoch)
        external
        onlyRiskGate
        nonReentrant
        returns (uint256 sent, bytes32 messageId)
    {
        uint256 need = computeNeedPerHarvest;
        uint256 fromFees = Math.min(feeAccrued, need);
        uint256 toOwner = feeAccrued - fromFees;
        feeAccrued = 0;
        ownerClaimable += toOwner;

        uint256 remainingNeed = need - fromFees;
        uint256 fromSurplus = Math.min(Math.min(remainingNeed, maxFromSurplus), harvestableIncome());
        // Consume unharvested income first, then mark safe-leg yield as spent.
        if (fromSurplus <= unharvestedIncome) {
            unharvestedIncome -= fromSurplus;
        } else {
            safeBasis += fromSurplus - unharvestedIncome;
            unharvestedIncome = 0;
        }

        sent = fromFees + fromSurplus;
        if (sent > 0) {
            _ensureLiquid(sent + ownerClaimable);
            IERC20(asset()).safeTransfer(harvestRouter, sent);
            messageId = IHarvestRouter(harvestRouter).route(agentId, sent, epoch);
            totalHarvested += sent;
        }
        emit Harvested(epoch, fromFees, fromSurplus, toOwner, messageId);
    }

    function payBounty(address keeper, uint256 amount) external onlyRiskGate nonReentrant {
        _ensureLiquid(amount + liabilities());
        IERC20(asset()).safeTransfer(keeper, amount);
        emit BountyPaid(keeper, amount);
    }

    function claimOwner(address to) external nonReentrant {
        require(msg.sender == agentOwner, "owner");
        uint256 amt = ownerClaimable;
        ownerClaimable = 0;
        _ensureLiquid(amt + feeAccrued);
        IERC20(asset()).safeTransfer(to, amt);
        emit OwnerClaimed(to, amt);
    }

    // =================================================================== internals

    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _pps() internal view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 1e18 : totalAssets().mulDiv(1e18, supply);
    }

    function _deployIdle() internal {
        if (address(safeLeg) == address(0)) return;
        uint256 bal = idle();
        uint256 keep = (totalAssets() * idleBufferBps) / BPS + liabilities();
        if (bal > keep) {
            uint256 amt = bal - keep;
            safeLeg.deposit(amt);
            safeBasis += amt;
        }
    }

    /// @dev Make sure at least `amount` of asset sits idle: safe leg first, then the wallet's stablecoin.
    function _ensureLiquid(uint256 amount) internal {
        uint256 bal = idle();
        if (bal >= amount) return;
        uint256 need = amount - bal;
        if (address(safeLeg) != address(0)) {
            uint256 got = safeLeg.withdraw(need);
            safeBasis = got > safeBasis ? 0 : safeBasis - got;
            if (got >= need) return;
            need -= got;
        }
        _pullFromWallet(need);
        if (idle() < amount) revert Insolvent();
    }

    function _pullFromWallet(uint256 amount) internal returns (uint256 got) {
        if (agentWallet == address(0) || amount == 0) return 0;
        got = IAgentWallet(agentWallet).returnToVault(asset(), amount);
        uint256 profit;
        int256 fundedBefore = walletFundedNet;
        int256 fundedPositive = fundedBefore > 0 ? fundedBefore : int256(0);
        if (int256(got) > fundedPositive) {
            profit = uint256(int256(got) - fundedPositive);
            unharvestedIncome += profit;
            incomeByEngine[bytes32("trading")] += profit;
        }
        walletFundedNet = fundedBefore - int256(got);
        if (walletFundedNet < 0) walletFundedNet = 0;
        emit WalletPulled(got, profit);
    }
}
