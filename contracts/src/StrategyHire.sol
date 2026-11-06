// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Client} from "./ccip/Client.sol";
import {IRouterClient} from "./ccip/IRouterClient.sol";
import {ISwapAdapter} from "./interfaces/IHarvestRouter.sol";

/// @title StrategyHire (vault chain, e.g. Base)
/// @notice Users hire a top agent (copy-trade + strategy access for a period) by paying in any accepted token.
///         The payment is swapped to the $0G Cross-Chain Token here and sent with Chainlink CCIP to the
///         HireReceiver on 0G Chain, which pays it to the agent's own (Privy) wallet. Prices come from the
///         leaderboard and are set by the platform operator; the payer's access is recorded here.
contract StrategyHire is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Plan {
        uint256 priceUsd; // in `usd` units (USDC: 6 decimals)
        uint32 periodDays;
        bool active;
    }

    IRouterClient public immutable ccipRouter;
    IERC20 public immutable usd; // pricing unit (USDC)
    IERC20 public zeroGToken; // $0G CCT on this chain
    ISwapAdapter public swapAdapter;
    uint64 public destChainSelector; // 0G Chain
    address public receiver; // HireReceiver on 0G Chain
    uint256 public destGasLimit = 250_000;
    uint256 public maxSlippageBps = 200;
    address public operator; // keeps plan prices in line with the leaderboard

    mapping(bytes32 => Plan) public plans;
    mapping(address => bool) public acceptedTokens;
    mapping(bytes32 => mapping(address => uint64)) public hiredUntil;

    event Configured(address zeroGToken, address swapAdapter, uint64 destChainSelector, address receiver);
    event OperatorSet(address operator);
    event TokenAccepted(address indexed token, bool ok);
    event PlanSet(bytes32 indexed agentId, uint256 priceUsd, uint32 periodDays, bool active);
    event Hired(
        bytes32 indexed agentId,
        address indexed subscriber,
        address tokenIn,
        uint256 amountIn,
        uint256 usdValue,
        uint256 zeroGOut,
        uint64 hiredUntil,
        bytes32 messageId,
        uint256 ccipFee
    );

    error NotOperator();
    error PlanInactive(bytes32 agentId);
    error TokenNotAccepted(address token);
    error Underpaid(uint256 usdValue, uint256 priceUsd);
    error InsufficientCcipFee(uint256 sent, uint256 fee);
    error NotConfigured();

    constructor(address ccipRouter_, address usd_, address owner_) Ownable(owner_) {
        ccipRouter = IRouterClient(ccipRouter_);
        usd = IERC20(usd_);
        acceptedTokens[usd_] = true;
        emit TokenAccepted(usd_, true);
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    function configure(address zeroGToken_, address swapAdapter_, uint64 destChainSelector_, address receiver_, uint256 destGasLimit_, uint256 maxSlippageBps_)
        external
        onlyOwner
    {
        zeroGToken = IERC20(zeroGToken_);
        swapAdapter = ISwapAdapter(swapAdapter_);
        destChainSelector = destChainSelector_;
        receiver = receiver_;
        destGasLimit = destGasLimit_;
        maxSlippageBps = maxSlippageBps_;
        emit Configured(zeroGToken_, swapAdapter_, destChainSelector_, receiver_);
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setAcceptedToken(address token, bool ok) external onlyOwner {
        acceptedTokens[token] = ok;
        emit TokenAccepted(token, ok);
    }

    function setPlan(bytes32 agentId, uint256 priceUsd, uint32 periodDays, bool active) external onlyOperator {
        require(periodDays > 0 && periodDays <= 365, "period");
        plans[agentId] = Plan(priceUsd, periodDays, active);
        emit PlanSet(agentId, priceUsd, periodDays, active);
    }

    /// @notice USD value of `amountIn` of `token`, priced through the same swap venue that converts it.
    function usdValue(address token, uint256 amountIn) public view returns (uint256) {
        if (token == address(usd)) return amountIn;
        return swapAdapter.quote(token, address(usd), amountIn);
    }

    function isHired(bytes32 agentId, address user) external view returns (bool) {
        return hiredUntil[agentId][user] > block.timestamp;
    }

    function buildMessage(bytes32 agentId, address subscriber, uint256 zeroGAmount, uint64 until)
        public
        view
        returns (Client.EVM2AnyMessage memory m)
    {
        Client.EVMTokenAmount[] memory toks = new Client.EVMTokenAmount[](1);
        toks[0] = Client.EVMTokenAmount({token: address(zeroGToken), amount: zeroGAmount});
        m = Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: abi.encode(agentId, subscriber, zeroGAmount, until),
            tokenAmounts: toks,
            feeToken: address(0),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV2({gasLimit: destGasLimit, allowOutOfOrderExecution: true}))
        });
    }

    /// @notice CCIP fee (native) for a hire paying `zeroGAmount`; send at least this as msg.value.
    function estimateFee(bytes32 agentId, uint256 zeroGAmount) external view returns (uint256) {
        return ccipRouter.getFee(destChainSelector, buildMessage(agentId, msg.sender, zeroGAmount, uint64(block.timestamp)));
    }

    /// @notice Pay `amountIn` of `tokenIn` to hire `agentId`. Swaps to 0G, sends it over CCIP to the agent's
    ///         wallet on 0G Chain, and extends the caller's access by the plan period. Excess native is refunded.
    function hire(bytes32 agentId, address tokenIn, uint256 amountIn, uint256 minZeroGOut)
        external
        payable
        nonReentrant
        returns (bytes32 messageId)
    {
        if (receiver == address(0) || address(zeroGToken) == address(0)) revert NotConfigured();
        Plan memory p = plans[agentId];
        if (!p.active) revert PlanInactive(agentId);
        if (!acceptedTokens[tokenIn]) revert TokenNotAccepted(tokenIn);
        uint256 value = usdValue(tokenIn, amountIn);
        if (value < p.priceUsd) revert Underpaid(value, p.priceUsd);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 out;
        if (tokenIn == address(zeroGToken)) {
            out = amountIn;
        } else {
            uint256 expected = swapAdapter.quote(tokenIn, address(zeroGToken), amountIn);
            uint256 floor = (expected * (10_000 - maxSlippageBps)) / 10_000;
            IERC20(tokenIn).forceApprove(address(swapAdapter), amountIn);
            out = swapAdapter.swapExactIn(tokenIn, address(zeroGToken), amountIn, floor > minZeroGOut ? floor : minZeroGOut);
        }

        uint64 start = hiredUntil[agentId][msg.sender] > block.timestamp ? hiredUntil[agentId][msg.sender] : uint64(block.timestamp);
        uint64 until = start + uint64(p.periodDays) * 1 days;
        hiredUntil[agentId][msg.sender] = until;

        Client.EVM2AnyMessage memory m = buildMessage(agentId, msg.sender, out, until);
        uint256 fee = ccipRouter.getFee(destChainSelector, m);
        if (msg.value < fee) revert InsufficientCcipFee(msg.value, fee);
        zeroGToken.forceApprove(address(ccipRouter), out);
        messageId = ccipRouter.ccipSend{value: fee}(destChainSelector, m);
        if (msg.value > fee) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - fee}("");
            require(ok, "refund");
        }
        emit Hired(agentId, msg.sender, tokenIn, amountIn, value, out, until, messageId, fee);
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) payable(to).transfer(amount);
        else IERC20(token).safeTransfer(to, amount);
    }
}
