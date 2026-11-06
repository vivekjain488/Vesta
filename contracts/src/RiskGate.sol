// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {CPPIMath} from "./libraries/CPPIMath.sol";
import {IRiskGate} from "./interfaces/IRiskGate.sol";
import {IAgentWallet} from "./interfaces/IAgentWallet.sol";
import {PerpetuaVault} from "./PerpetuaVault.sol";

/// @title RiskGate
/// @notice The single, deterministic authority over risk. It never runs or trusts an LLM. It:
///           1. on every public poke(): marks the vault (on-chain reads) and the agent wallet (fresh signed price
///              attestations, <= 60s old), computes F, C and E, applies circuit breakers, harvests surplus to
///              0G via the vault, keeps the trading wallet at <= E, and pays the keeper a bounty;
///           2. on approveOrder(): checks a proposed Flash order against the CURRENT mandate, the attached 0G
///              TEE-signed inference proof and a fresh price, then records the Flash EIP-712 digest as approved.
///         AgentWallet.isValidSignature (EIP-1271) returns valid only for digests approved here.
///
/// @dev    KNOWN TRADE-OFFS (stated, not hidden):
///         - Flash's order typed data is built server-side (QuoteResponse.evm.orderTypedData) and its struct is
///           not published as a stable schema, so RiskGate cannot yet re-derive the digest from the intent on
///           its own. Until `orderHasher` is set (day-one task), the digest<->intent binding is attested by the
///           proposer, and the HARD protection is the fallback from the spec: AgentWallet's token allowance
///           to Flash is raised only by `amountIn` per approved order and capped at E, and the wallet never
///           holds more than E. A bad binding therefore cannot spend more than the current budget.
///         - Flash quotes are not signed by Definitive. Prices enter via `priceSigner`, a relayer key that
///           fetches the Flash /quote and attests (asset, priceE8, timestamp). Enforcement and execution still
///           use the same number: the order's own amountIn/minAmountOut must agree with that attested price.
contract RiskGate is IRiskGate, Ownable, EIP712 {
    using Math for uint256;

    uint256 internal constant BPS = 10_000;
    bytes32 public constant PRICE_TYPEHASH =
        keccak256("PriceAttestation(address asset,uint256 priceE8,uint64 timestamp)");

    // ------------------------------------------------------------------ types
    enum Kind {
        Entry, // stable -> risky asset (adds exposure)
        Exit // risky asset -> stable (reduces exposure: stops, take-profits, brackets)
    }

    struct AssetConfig {
        bool allowed;
        uint8 decimals;
        uint16 dailyVolBps; // used by the 1-day VaR check, refreshed by governance from realised vol
    }

    struct PriceAttestation {
        address asset;
        uint256 priceE8;
        uint64 timestamp;
        bytes signature;
    }

    struct OrderIntent {
        bytes32 flashDigest; // EIP-712 digest of QuoteResponse.evm.orderTypedData
        bytes32 bracketDigest; // digest of attachedBracket.evm.orderTypedData (0 if none)
        Kind kind;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 stopPriceE8; // required for entries
        uint256 takeProfitPriceE8;
        uint64 deadline;
        address recipient;
    }

    /// @notice 0G Compute TEE proof. `response` is the exact text the provider's TEE signed (EIP-191
    ///         personal_sign), the same thing broker.inference.processResponse verifies off-chain.
    struct TeeProof {
        bytes32 chatIdHash;
        bytes response;
        bytes signature;
    }

    struct Mandate {
        uint64 epoch;
        uint64 computedAt;
        uint64 validUntil;
        uint256 V;
        uint256 F;
        uint256 C;
        uint256 E;
        uint256 riskyValue;
        bytes32 stateHash;
    }

    struct Approval {
        uint64 expiry;
        uint64 epoch;
        Kind kind;
        uint256 notional;
        bytes32 responseHash;
    }

    // ------------------------------------------------------------------ config
    PerpetuaVault public immutable vault;
    address public immutable wallet;
    IERC20 public immutable stable;

    uint256 public multiplier = 3; // m
    uint256 public eMax; // absolute cap set at registration
    uint8 public immutable riskTier; // 0 Conservative, 1 Balanced, 2 Aggressive -- locked
    uint64 public approvalWindow = 4 hours + 30 minutes;
    uint64 public exitApprovalTtl = 30 days;
    uint64 public maxPriceAge = 60;
    uint64 public minPokeInterval = 4 hours;
    uint64 public fastPokeInterval = 30 minutes; // used while high-vol mode is on
    uint256 public maxPriceDeviationBps = 150; // order price vs attested price
    uint256 public keeperBounty; // stable units
    uint256 public maxHarvestPerCycle;
    uint256 public minHarvest;

    address public proposer; // agent runtime key: can PROPOSE only
    address public guardian;
    address public priceSigner;
    address public orderHasher; // optional: on-chain recomputation of Flash's digest (day-one)
    mapping(address => bool) public teeSigners; // acknowledged 0G provider TEE signer addresses
    mapping(address => AssetConfig) public assets;
    address[] public assetList;

    // ------------------------------------------------------------------ state
    Mandate public mandate;
    mapping(bytes32 => Approval) public approvals;
    mapping(uint64 => uint256) public entryNotionalInEpoch;
    uint256 public lastRiskyValue; // risky leg marked at the last poke (stablecoin is read live)
    uint64 public lastPaidPoke;
    bool public hibernating;
    bool public withdrawalPaused; // owner-requested sleep survives income, deposits and keeper pokes
    uint256 public minimumOperatingCapital = 25e6; // USDC units; owner configurable
    bool public highVolMode;

    // circuit breakers
    uint64 public dayStart;
    uint256 public dayStartCushion;
    uint256 public cushionPeak;
    uint64 public haltedUntil;
    bool public tradingOff; // drawdown > 30% of peak cushion -> services only
    bool public halfSize; // set by guardian/runtime after 3 consecutive losses

    // ------------------------------------------------------------------ events
    event MandateRefreshed(
        uint64 indexed epoch, uint256 V, uint256 F, uint256 C, uint256 E, uint256 riskyValue, uint64 validUntil
    );
    event PokeNoop(address indexed keeper);
    event Hibernation(bool on, bytes32 reason);
    event WithdrawalSleep(bool on, address indexed agentOwner);
    event CircuitBreaker(bytes32 indexed kind, uint256 value);
    event OrderApproved(
        bytes32 indexed digest, uint64 indexed epoch, Kind kind, uint256 notional, uint64 expiry, bytes32 responseHash
    );
    event OrderRejected(bytes32 indexed digest, bytes32 reason);
    event ApprovalRevoked(bytes32 indexed digest);
    event ConfigChanged(bytes32 indexed what);

    error Rejected(bytes32 reason);
    error OnlyProposer();
    error OnlyGuardian();

    // reason codes (also returned by checkOrder and reused by the paid risk-check API)
    bytes32 public constant R_OK = "OK";
    bytes32 public constant R_HIBERNATING = "HIBERNATING";
    bytes32 public constant R_MANDATE_STALE = "MANDATE_STALE";
    bytes32 public constant R_HALTED = "CIRCUIT_HALT";
    bytes32 public constant R_TRADING_OFF = "DRAWDOWN_OFF";
    bytes32 public constant R_ASSET = "ASSET_NOT_ALLOWED";
    bytes32 public constant R_RECIPIENT = "RECIPIENT_NOT_WALLET";
    bytes32 public constant R_NO_STOP = "NO_STOP";
    bytes32 public constant R_STOP_GAP = "STOP_OUTSIDE_GAP";
    bytes32 public constant R_EXPIRY = "EXPIRY_TOO_LONG";
    bytes32 public constant R_PRICE_STALE = "PRICE_STALE";
    bytes32 public constant R_PRICE_DEV = "PRICE_DEVIATION";
    bytes32 public constant R_EXPOSURE = "EXCEEDS_EXPOSURE";
    bytes32 public constant R_VAR = "VAR_EXCEEDS_CUSHION";
    bytes32 public constant R_TEE = "TEE_PROOF_INVALID";
    bytes32 public constant R_DUP = "ALREADY_APPROVED";
    bytes32 public constant R_BALANCE = "INSUFFICIENT_BALANCE";
    bytes32 public constant R_TP = "BAD_TAKE_PROFIT";

    constructor(
        address vault_,
        address wallet_,
        uint256 eMax_,
        uint8 riskTier_,
        address proposer_,
        address priceSigner_,
        address owner_
    ) Ownable(owner_) EIP712("PerpetuaRiskGate", "1") {
        require(riskTier_ <= 2, "tier");
        vault = PerpetuaVault(vault_);
        wallet = wallet_;
        stable = IERC20(PerpetuaVault(vault_).asset());
        eMax = eMax_;
        riskTier = riskTier_;
        proposer = proposer_;
        priceSigner = priceSigner_;
        guardian = owner_;
    }

    // ================================================================== admin (bounded)

    function setMultiplier(uint256 m) external onlyOwner {
        require(m >= 1 && m <= 4, "m<=4"); // gap tolerance 1/m must stay >= 25%
        multiplier = m;
        emit ConfigChanged("multiplier");
    }

    function setAsset(address asset, bool allowed, uint16 dailyVolBps) external onlyOwner {
        if (assets[asset].decimals == 0 && allowed) assetList.push(asset);
        assets[asset] = AssetConfig(allowed, IERC20Metadata(asset).decimals(), dailyVolBps);
        emit ConfigChanged("asset");
    }

    function setTeeSigner(address signer, bool ok) external onlyOwner {
        teeSigners[signer] = ok;
        emit ConfigChanged("tee");
    }

    function setRoles(address proposer_, address guardian_, address priceSigner_) external onlyOwner {
        proposer = proposer_;
        guardian = guardian_;
        priceSigner = priceSigner_;
        emit ConfigChanged("roles");
    }

    function setKeeperEconomics(uint256 bounty, uint256 maxHarvest, uint256 minHarvest_, uint64 minInterval)
        external
        onlyOwner
    {
        keeperBounty = bounty;
        maxHarvestPerCycle = maxHarvest;
        minHarvest = minHarvest_;
        minPokeInterval = minInterval;
        emit ConfigChanged("keeper");
    }

    function setWindows(uint64 approvalWindow_, uint64 exitTtl, uint64 maxPriceAge_, uint256 maxDevBps)
        external
        onlyOwner
    {
        require(maxPriceAge_ <= 60, "<=60s");
        approvalWindow = approvalWindow_;
        exitApprovalTtl = exitTtl;
        maxPriceAge = maxPriceAge_;
        maxPriceDeviationBps = maxDevBps;
        emit ConfigChanged("windows");
    }

    function setOrderHasher(address h) external onlyOwner {
        orderHasher = h;
        emit ConfigChanged("hasher");
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian && msg.sender != owner()) revert OnlyGuardian();
        _;
    }

    /// @notice Runtime reports 3 losses in a row -> half size; or detected high volatility -> faster pokes.
    function setRuntimeFlags(bool halfSize_, bool highVol_) external {
        if (msg.sender != proposer && msg.sender != guardian && msg.sender != owner()) revert OnlyGuardian();
        // The proposer may only TIGHTEN (turn flags on); loosening needs the guardian.
        if (msg.sender == proposer) {
            require((halfSize_ || !halfSize) && (highVol_ || !highVolMode), "tighten only");
        }
        halfSize = halfSize_;
        highVolMode = highVol_;
        emit ConfigChanged("flags");
    }

    /// @notice Any position without a live stop (seen by a keeper's read-only Flash GET) forces hibernation.
    function forceHibernate(bytes32 reason) external onlyGuardian {
        _enterHibernation(reason);
    }

    /// @notice Sleep first, even if risky holdings must settle before a full redemption is liquid.
    ///         Existing risk-reducing exits remain valid. This does not pretend to execute an unwind.
    function requestWithdrawalSleep() external {
        require(msg.sender == vault.agentOwner(), "agent owner only");
        _pauseForWithdrawal();
        uint256 bal = stable.balanceOf(wallet);
        if (bal > 0) vault.pullFromWallet(bal);
    }

    function setMinimumOperatingCapital(uint256 amount) external {
        require(msg.sender == vault.agentOwner(), "agent owner only");
        require(amount > 0, "zero minimum");
        minimumOperatingCapital = amount;
        emit ConfigChanged("minimumCapital");
    }

    /// @inheritdoc IRiskGate
    function onOwnerWithdrawal() external {
        require(msg.sender == address(vault), "vault only");
        // Called under the vault's withdrawal reentrancy guard: no callback into the vault here.
        if (vault.convertToAssets(vault.balanceOf(vault.agentOwner())) < minimumOperatingCapital) {
            _pauseForWithdrawal();
        } else {
            // Capital changed: old entries cannot spend against the pre-withdrawal mandate.
            // Existing exits survive the epoch change and a fresh poke can resume normal entries.
            mandate.epoch += 1;
            mandate.validUntil = 0;
            mandate.E = 0;
            IAgentWallet(wallet).revokeFlashAllowance(address(stable));
        }
    }

    /// @notice Deposits/income do not wake a user-paused agent. Owner explicitly resumes; a fresh
    ///         poke must then issue a new mandate before any entry can be approved.
    function resumeAfterWithdrawal() external {
        require(msg.sender == vault.agentOwner(), "agent owner only");
        require(withdrawalPaused, "not sleeping");
        require(vault.convertToAssets(vault.balanceOf(msg.sender)) >= minimumOperatingCapital, "capital below minimum");
        withdrawalPaused = false;
        mandate.validUntil = 0; // force a fresh mandate even inside the keeper's normal interval
        vault.resetFeeClock();
        emit WithdrawalSleep(false, msg.sender);
    }

    function _pauseForWithdrawal() internal {
        if (!withdrawalPaused) emit WithdrawalSleep(true, vault.agentOwner());
        withdrawalPaused = true;
        if (!hibernating) emit Hibernation(true, "OWNER_WITHDRAWAL");
        hibernating = true;
        mandate.E = 0;
        vault.resetFeeClock();
        IAgentWallet(wallet).revokeFlashAllowance(address(stable));
    }

    function resetDrawdownBreaker() external onlyOwner {
        tradingOff = false;
        cushionPeak = mandate.C;
        emit CircuitBreaker("DRAWDOWN_RESET", mandate.C);
    }

    // ================================================================== views

    /// @notice Wallet value = live stablecoin balance + risky holdings marked at the last poke.
    function walletValue() external view returns (uint256) {
        return stable.balanceOf(wallet) + lastRiskyValue;
    }

    function assetCount() external view returns (uint256) {
        return assetList.length;
    }

    function isApproved(bytes32 digest) external view returns (bool) {
        Approval memory a = approvals[digest];
        if (a.expiry == 0 || block.timestamp > a.expiry) return false;
        if (a.kind == Kind.Exit) return true; // risk-reducing orders stay valid through hibernation
        if (hibernating || a.epoch != mandate.epoch) return false;
        return true;
    }

    function priceDigest(address asset, uint256 priceE8, uint64 timestamp) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, asset, priceE8, timestamp)));
    }

    function currentPokeInterval() public view returns (uint64) {
        return highVolMode ? fastPokeInterval : minPokeInterval;
    }

    /// @notice Pure preview of F/C/E for arbitrary inputs: lets anyone (and the paid risk-check service)
    ///         replay RiskGate's math without trusting the agent.
    function previewMandate(uint256 V, uint256 P, uint256 piBps, uint256 R, uint256 m, uint256 eMax_)
        external
        pure
        returns (uint256 F, uint256 C, uint256 E)
    {
        F = CPPIMath.floorValue(P, piBps, R);
        C = CPPIMath.cushion(V, F);
        E = CPPIMath.exposureBudget(C, m, eMax_);
    }

    // ================================================================== poke()

    /// @notice Public, permissionless risk refresh + harvest. Idempotent: a second call with no state change
    ///         inside the poke interval is a no-op and pays nothing.
    function poke(PriceAttestation[] calldata prices) external returns (bool refreshed) {
        (uint256 riskyValue, bool pricesOk) = _markWallet(prices);
        uint256 walletStable = stable.balanceOf(wallet);
        uint256 walletVal = walletStable + riskyValue;

        bool intervalElapsed = block.timestamp >= lastPaidPoke + currentPokeInterval();
        bytes32 stateHash =
            keccak256(abi.encode(vault.vaultSideAssets(), walletVal, riskyValue, vault.principal(), pricesOk, hibernating, withdrawalPaused));
        if (!intervalElapsed && stateHash == mandate.stateHash && block.timestamp <= mandate.validUntil) {
            emit PokeNoop(msg.sender);
            return false;
        }
        lastRiskyValue = riskyValue;

        // 1. mark-to-market V and F
        uint256 F = vault.floorValue();
        uint256 V = vault.vaultSideAssets() + walletVal;
        uint256 C = CPPIMath.cushion(V, F);

        // 2. fees come out of the cushion only
        if (C > 0 && !withdrawalPaused) {
            vault.accrueFees(C);
            V = vault.vaultSideAssets() + walletVal;
            C = CPPIMath.cushion(V, F);
        }

        // 3. harvest surplus to 0G (only on paid cycles, never more than the cushion)
        uint64 nextEpoch = mandate.epoch + 1;
        if (intervalElapsed && C > 0 && !withdrawalPaused) {
            uint256 cap = Math.min(maxHarvestPerCycle, C);
            if (vault.computeNeedPerHarvest() >= minHarvest && cap > 0) {
                vault.harvest(cap, nextEpoch);
                V = vault.vaultSideAssets() + walletVal;
                C = CPPIMath.cushion(V, F);
            }
        }

        // 4. exposure budget + circuit breakers
        uint256 E = CPPIMath.exposureBudget(C, multiplier, eMax);
        E = _applyBreakers(C, E);
        if (!pricesOk) {
            _enterHibernation(R_PRICE_STALE);
        } else if (hibernating && E > 0 && !withdrawalPaused) {
            hibernating = false;
            emit Hibernation(false, "INCOME_LANDED");
        }
        if (hibernating) E = 0;

        // 5. wallet cap: the wallet never holds more than E
        _rebalanceWallet(E, stable.balanceOf(wallet), riskyValue);
        uint256 walletAfter = stable.balanceOf(wallet) + riskyValue;

        // 6. keeper bounty, at most once per interval (paid before hashing state so a repeat poke is a no-op)
        if (intervalElapsed) {
            lastPaidPoke = uint64(block.timestamp);
            if (!withdrawalPaused && keeperBounty > 0 && C > keeperBounty) vault.payBounty(msg.sender, keeperBounty);
        }

        mandate = Mandate({
            epoch: nextEpoch,
            computedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp) + approvalWindow,
            V: V,
            F: F,
            C: C,
            E: E,
            riskyValue: riskyValue,
            stateHash: keccak256(
                abi.encode(vault.vaultSideAssets(), walletAfter, riskyValue, vault.principal(), pricesOk, hibernating, withdrawalPaused)
            )
        });
        emit MandateRefreshed(nextEpoch, V, F, C, E, riskyValue, mandate.validUntil);
        return true;
    }

    // ================================================================== order gate

    /// @notice View-only check, also used by the x402 risk-check service. Returns R_OK or a reason code.
    function checkOrder(OrderIntent calldata o, PriceAttestation calldata px) public view returns (bytes32) {
        if (approvals[o.flashDigest].expiry != 0) return R_DUP;
        if (o.recipient != wallet) return R_RECIPIENT;

        if (o.kind == Kind.Exit) {
            if (o.tokenOut != address(stable) || !assets[o.tokenIn].allowed) return R_ASSET;
            if (IERC20(o.tokenIn).balanceOf(wallet) < o.amountIn) return R_BALANCE;
            return R_OK;
        }

        if (hibernating) return R_HIBERNATING;
        if (block.timestamp > mandate.validUntil || mandate.epoch == 0) return R_MANDATE_STALE;
        if (block.timestamp < haltedUntil) return R_HALTED;
        if (tradingOff) return R_TRADING_OFF;
        if (o.tokenIn != address(stable)) return R_ASSET;
        AssetConfig memory ac = assets[o.tokenOut];
        if (!ac.allowed) return R_ASSET;
        if (o.deadline > mandate.validUntil) return R_EXPIRY;

        // price sanity: fresh signed price, and the order's own implied price must agree with it
        if (!_validPrice(px) || px.asset != o.tokenOut) return R_PRICE_STALE;
        if (o.minAmountOut == 0) return R_PRICE_DEV;
        // implied price (E8) = amountIn(stable, 6dp) / minAmountOut(asset) scaled
        uint256 impliedE8 = (o.amountIn * (10 ** (uint256(ac.decimals) + 2))) / o.minAmountOut;
        if (CPPIMath.deviationBps(impliedE8, px.priceE8) > maxPriceDeviationBps) return R_PRICE_DEV;

        // stop present and inside the CPPI gap tolerance 1/m
        if (o.stopPriceE8 == 0) return R_NO_STOP;
        if (!CPPIMath.stopInsideGap(px.priceE8, o.stopPriceE8, multiplier)) return R_STOP_GAP;
        if (o.takeProfitPriceE8 != 0 && o.takeProfitPriceE8 <= px.priceE8) return R_TP;

        // size <= E - open exposure (shared budget across all risky assets)
        uint256 E = halfSize ? mandate.E / 2 : mandate.E;
        uint256 open = mandate.riskyValue + entryNotionalInEpoch[mandate.epoch];
        if (open + o.amountIn > E) return R_EXPOSURE;

        // 1-day VaR on total exposure must fit inside the cushion
        if (CPPIMath.valueAtRisk(open + o.amountIn, ac.dailyVolBps) > mandate.C) return R_VAR;
        return R_OK;
    }

    /// @notice Agent submits a proposal: Flash digest(s) + intent + the 0G TEE proof that produced it.
    ///         A rejection reverts on-chain (the demo's "reckless trade" tx).
    function approveOrder(OrderIntent calldata o, PriceAttestation calldata px, TeeProof calldata proof)
        external
        returns (bytes32 responseHash)
    {
        if (msg.sender != proposer) revert OnlyProposer();
        responseHash = _verifyTee(proof);
        if (responseHash == bytes32(0)) revert Rejected(R_TEE);
        if (orderHasher != address(0)) {
            // Day-one upgrade path: on-chain recomputation of Flash's EIP-712 digest from the intent.
            (bool ok, bytes memory ret) = orderHasher.staticcall(abi.encodeWithSignature("hash((bytes32,bytes32,uint8,address,address,uint256,uint256,uint256,uint256,uint64,address))", o));
            require(ok && abi.decode(ret, (bytes32)) == o.flashDigest, "digest mismatch");
        }
        bytes32 reason = checkOrder(o, px);
        if (reason != R_OK) revert Rejected(reason);

        uint64 expiry;
        if (o.kind == Kind.Entry) {
            expiry = o.deadline;
            entryNotionalInEpoch[mandate.epoch] += o.amountIn;
            uint256 E = halfSize ? mandate.E / 2 : mandate.E;
            IAgentWallet(wallet).grantFlashAllowance(o.tokenIn, o.amountIn, E);
        } else {
            expiry = uint64(block.timestamp) + exitApprovalTtl;
            IAgentWallet(wallet).grantFlashAllowance(o.tokenIn, o.amountIn, IERC20(o.tokenIn).balanceOf(wallet));
        }
        approvals[o.flashDigest] = Approval(expiry, mandate.epoch, o.kind, o.amountIn, responseHash);
        emit OrderApproved(o.flashDigest, mandate.epoch, o.kind, o.amountIn, expiry, responseHash);

        // Attached bracket (stop-loss + take-profit sell of what the entry receives): risk-reducing.
        if (o.bracketDigest != bytes32(0) && approvals[o.bracketDigest].expiry == 0) {
            uint64 bExpiry = uint64(block.timestamp) + exitApprovalTtl;
            approvals[o.bracketDigest] = Approval(bExpiry, mandate.epoch, Kind.Exit, o.minAmountOut, responseHash);
            IAgentWallet(wallet).grantFlashAllowance(o.tokenOut, o.minAmountOut, type(uint256).max);
            emit OrderApproved(o.bracketDigest, mandate.epoch, Kind.Exit, o.minAmountOut, bExpiry, responseHash);
        }
    }

    function revokeApproval(bytes32 digest) external {
        if (msg.sender != proposer && msg.sender != guardian && msg.sender != owner()) revert OnlyGuardian();
        delete approvals[digest];
        emit ApprovalRevoked(digest);
    }

    // ================================================================== internals

    function _validPrice(PriceAttestation calldata px) internal view returns (bool) {
        if (px.timestamp > block.timestamp || block.timestamp - px.timestamp > maxPriceAge) return false;
        (address rec, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(priceDigest(px.asset, px.priceE8, px.timestamp), px.signature);
        return err == ECDSA.RecoverError.NoError && rec == priceSigner && px.priceE8 > 0;
    }

    /// @dev Marks every allow-listed risky asset the wallet holds. Any held asset without a fresh, validly
    ///      signed price makes the mark "not ok" -> hibernation (never a guess).
    function _markWallet(PriceAttestation[] calldata prices) internal view returns (uint256 value, bool ok) {
        ok = true;
        for (uint256 i; i < assetList.length; ++i) {
            address a = assetList[i];
            uint256 bal = IERC20(a).balanceOf(wallet);
            if (bal == 0) continue;
            bool found;
            for (uint256 j; j < prices.length; ++j) {
                if (prices[j].asset == a && _validPrice(prices[j])) {
                    value += CPPIMath.usdcValue(bal, assets[a].decimals, prices[j].priceE8);
                    found = true;
                    break;
                }
            }
            if (!found) ok = false;
        }
    }

    function _verifyTee(TeeProof calldata p) internal view returns (bytes32) {
        if (p.response.length == 0) return bytes32(0);
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(p.response);
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, p.signature);
        if (err != ECDSA.RecoverError.NoError || !teeSigners[rec]) return bytes32(0);
        return keccak256(p.response);
    }

    function _applyBreakers(uint256 C, uint256 E) internal returns (uint256) {
        // daily loss > 20% of the day's starting cushion -> no new trades for 24h
        if (block.timestamp >= dayStart + 1 days) {
            dayStart = uint64(block.timestamp);
            dayStartCushion = C;
        } else if (dayStartCushion > 0 && C < dayStartCushion && (dayStartCushion - C) * BPS > dayStartCushion * 2_000)
        {
            if (haltedUntil < block.timestamp) {
                haltedUntil = uint64(block.timestamp + 1 days);
                emit CircuitBreaker("DAILY_LOSS", dayStartCushion - C);
            }
        }
        // drawdown > 30% of peak cushion -> trading off, services only
        if (C > cushionPeak) cushionPeak = C;
        if (!tradingOff && cushionPeak > 0 && (cushionPeak - C) * BPS > cushionPeak * 3_000) {
            tradingOff = true;
            emit CircuitBreaker("DRAWDOWN", cushionPeak - C);
        }
        if (block.timestamp < haltedUntil || tradingOff) return 0;
        return E;
    }

    function _rebalanceWallet(uint256 E, uint256 walletStable, uint256 riskyValue) internal {
        uint256 target = E > riskyValue ? E - riskyValue : 0;
        if (walletStable > target) {
            vault.pullFromWallet(walletStable - target);
        } else if (target > walletStable) {
            uint256 add = target - walletStable;
            uint256 room = vault.vaultSideAssets();
            if (add > room) add = room;
            if (add > 0) vault.fundWallet(add);
        }
    }

    function _enterHibernation(bytes32 reason) internal {
        if (!hibernating) {
            hibernating = true;
            emit Hibernation(true, reason);
        }
        IAgentWallet(wallet).revokeFlashAllowance(address(stable));
        uint256 bal = stable.balanceOf(wallet);
        if (bal > 0) vault.pullFromWallet(bal);
    }
}
