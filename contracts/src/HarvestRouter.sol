// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Client} from "./ccip/Client.sol";
import {IRouterClient} from "./ccip/IRouterClient.sol";
import {IHarvestRouter, ISwapAdapter} from "./interfaces/IHarvestRouter.sol";

/// @title HarvestRouter
/// @notice Swap-then-bridge leg of the money loop. Receives harvested surplus (in whatever token this chain's
///         vault holds), swaps it locally into the native $0G Cross-Chain Token, and sends it to the
///         ComputeTreasury on 0G Chain with Chainlink CCIP. The CCIP message data is (agentId, amount, epoch).
///         CCIP is used for exactly this one job. It does not move trading capital or carry prices.
/// @dev    Day-one check: which source chains have a live $0G CCT token pool + lane into 0G (Galileo testnet /
///         mainnet). `zeroGToken` must be the CCT's address on THIS chain, `destChainSelector` the 0G chain's
///         CCIP selector. CCIP fees are paid in native gas held by this contract (counted as agent burn).
contract HarvestRouter is IHarvestRouter, Ownable {
    using SafeERC20 for IERC20;

    IRouterClient public immutable ccipRouter;
    IERC20 public immutable inputToken; // vault asset (e.g. USDC)
    IERC20 public zeroGToken; // $0G CCT on this chain
    ISwapAdapter public swapAdapter;
    uint64 public destChainSelector;
    address public computeTreasury; // receiver on 0G Chain
    uint256 public maxSlippageBps = 100;
    uint256 public destGasLimit = 300_000;
    mapping(address => bool) public allowedVaults;

    event HarvestBridged(
        bytes32 indexed messageId, bytes32 indexed agentId, uint64 epoch, uint256 amountIn, uint256 zeroGOut, uint256 ccipFee
    );
    event ConfigSet();

    error NotVault();
    error InsufficientCcipFee(uint256 have, uint256 need);

    constructor(address ccipRouter_, address inputToken_, address owner_) Ownable(owner_) {
        ccipRouter = IRouterClient(ccipRouter_);
        inputToken = IERC20(inputToken_);
    }

    function configure(
        address zeroGToken_,
        address swapAdapter_,
        uint64 destChainSelector_,
        address computeTreasury_,
        uint256 maxSlippageBps_,
        uint256 destGasLimit_
    ) external onlyOwner {
        zeroGToken = IERC20(zeroGToken_);
        swapAdapter = ISwapAdapter(swapAdapter_);
        destChainSelector = destChainSelector_;
        computeTreasury = computeTreasury_;
        maxSlippageBps = maxSlippageBps_;
        destGasLimit = destGasLimit_;
        emit ConfigSet();
    }

    function setVault(address v, bool ok) external onlyOwner {
        allowedVaults[v] = ok;
    }

    function buildMessage(bytes32 agentId, uint256 zeroGAmount, uint64 epoch)
        public
        view
        returns (Client.EVM2AnyMessage memory m)
    {
        Client.EVMTokenAmount[] memory toks = new Client.EVMTokenAmount[](1);
        toks[0] = Client.EVMTokenAmount({token: address(zeroGToken), amount: zeroGAmount});
        m = Client.EVM2AnyMessage({
            receiver: abi.encode(computeTreasury),
            data: abi.encode(agentId, zeroGAmount, epoch),
            tokenAmounts: toks,
            feeToken: address(0),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV2({gasLimit: destGasLimit, allowOutOfOrderExecution: true}))
        });
    }

    function estimateFee(bytes32 agentId, uint256 zeroGAmount, uint64 epoch) external view returns (uint256) {
        return ccipRouter.getFee(destChainSelector, buildMessage(agentId, zeroGAmount, epoch));
    }

    /// @inheritdoc IHarvestRouter
    function route(bytes32 agentId, uint256 amount, uint64 epoch) external returns (bytes32 messageId) {
        if (!allowedVaults[msg.sender]) revert NotVault();
        // 1. swap locally into 0G (vault already transferred `amount` of inputToken here)
        uint256 out;
        if (address(inputToken) == address(zeroGToken)) {
            out = amount;
        } else {
            uint256 expected = swapAdapter.quote(address(inputToken), address(zeroGToken), amount);
            uint256 minOut = (expected * (10_000 - maxSlippageBps)) / 10_000;
            inputToken.forceApprove(address(swapAdapter), amount);
            out = swapAdapter.swapExactIn(address(inputToken), address(zeroGToken), amount, minOut);
        }
        // 2. CCIP send to ComputeTreasury on 0G Chain
        Client.EVM2AnyMessage memory m = buildMessage(agentId, out, epoch);
        uint256 fee = ccipRouter.getFee(destChainSelector, m);
        if (address(this).balance < fee) revert InsufficientCcipFee(address(this).balance, fee);
        zeroGToken.forceApprove(address(ccipRouter), out);
        messageId = ccipRouter.ccipSend{value: fee}(destChainSelector, m);
        emit HarvestBridged(messageId, agentId, epoch, amount, out, fee);
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) payable(to).transfer(amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    receive() external payable {}
}
