// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Client} from "../ccip/Client.sol";
import {IRouterClient, IAny2EVMMessageReceiver} from "../ccip/IRouterClient.sol";

/// @notice Local single-chain CCIP simulator for Foundry tests and the offline demo. It locks tokens on
///         `ccipSend` and, on `deliver`, releases them to the receiver and calls `ccipReceive` exactly like the
///         real OffRamp would. Delivery is manual (or `autoDeliver`) so tests can model cross-chain latency.
contract MockCCIPRouter is IRouterClient {
    using SafeERC20 for IERC20;

    uint64 public immutable localChainSelector;
    uint256 public flatFee = 0.0005 ether;
    bool public autoDeliver;
    uint256 public nonce;

    struct Pending {
        uint64 destChain;
        address sender;
        address receiver;
        bytes data;
        Client.EVMTokenAmount[] tokens;
        bool delivered;
    }

    mapping(bytes32 => Pending) internal _pending;
    bytes32[] public messageIds;

    event MessageSent(bytes32 indexed messageId, uint64 indexed destChain, address receiver);
    event MessageDelivered(bytes32 indexed messageId);

    constructor(uint64 localChainSelector_) {
        localChainSelector = localChainSelector_;
    }

    function setAutoDeliver(bool v) external {
        autoDeliver = v;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return flatFee;
    }

    function ccipSend(uint64 destChain, Client.EVM2AnyMessage calldata message) external payable returns (bytes32 id) {
        if (message.feeToken == address(0) && msg.value < flatFee) revert InsufficientFeeTokenAmount();
        id = keccak256(abi.encode(block.chainid, ++nonce, msg.sender));
        Pending storage p = _pending[id];
        p.destChain = destChain;
        p.sender = msg.sender;
        p.receiver = abi.decode(message.receiver, (address));
        p.data = message.data;
        for (uint256 i; i < message.tokenAmounts.length; ++i) {
            IERC20(message.tokenAmounts[i].token).safeTransferFrom(
                msg.sender, address(this), message.tokenAmounts[i].amount
            );
            p.tokens.push(message.tokenAmounts[i]);
        }
        messageIds.push(id);
        emit MessageSent(id, destChain, p.receiver);
        if (autoDeliver) deliver(id);
    }

    function deliver(bytes32 id) public {
        Pending storage p = _pending[id];
        require(p.receiver != address(0) && !p.delivered, "bad msg");
        p.delivered = true;
        Client.EVMTokenAmount[] memory toks = new Client.EVMTokenAmount[](p.tokens.length);
        for (uint256 i; i < p.tokens.length; ++i) {
            toks[i] = p.tokens[i];
            IERC20(p.tokens[i].token).safeTransfer(p.receiver, p.tokens[i].amount);
        }
        IAny2EVMMessageReceiver(p.receiver).ccipReceive(
            Client.Any2EVMMessage({
                messageId: id,
                sourceChainSelector: localChainSelector,
                sender: abi.encode(p.sender),
                data: p.data,
                destTokenAmounts: toks
            })
        );
        emit MessageDelivered(id);
    }

    function messageCount() external view returns (uint256) {
        return messageIds.length;
    }
}
