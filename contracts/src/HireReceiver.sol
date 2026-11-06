// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Client} from "./ccip/Client.sol";
import {CCIPReceiver} from "./ccip/CCIPReceiver.sol";

interface IWrapped0G {
    function withdraw(uint256) external;
}

/// @title HireReceiver (0G Chain)
/// @notice Receives hire payments sent by StrategyHire over Chainlink CCIP and pays the $0G that actually
///         arrived to the hired agent's own wallet (its Privy server wallet). If the CCIP token pool releases
///         wrapped 0G (W0G), it is unwrapped to native 0G first. Payments for an agent with no payout wallet
///         yet are held and released once one is set.
contract HireReceiver is CCIPReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable zeroGToken; // the CCT as delivered by the token pool on this chain
    bool public unwrapToNative;
    mapping(uint64 => mapping(address => bool)) public allowedSenders; // source chain selector => StrategyHire
    mapping(bytes32 => address) public payoutOf; // agentId => agent wallet on 0G Chain
    mapping(bytes32 => uint256) public held; // agentId => 0G waiting for a payout wallet
    mapping(bytes32 => uint256) public paidTotal;
    mapping(bytes32 => bool) public processed; // messageId

    event SenderAllowed(uint64 indexed chainSelector, address indexed sender, bool ok);
    event PayoutSet(bytes32 indexed agentId, address payout);
    event HirePaid(bytes32 indexed messageId, bytes32 indexed agentId, address indexed subscriber, address payout, uint256 amount, bool native, uint64 hiredUntil);
    event HireHeld(bytes32 indexed messageId, bytes32 indexed agentId, address indexed subscriber, uint256 amount);

    error UnknownSender(uint64 chainSelector, address sender);
    error Duplicate();

    constructor(address router, address zeroGToken_, address owner_) CCIPReceiver(router) Ownable(owner_) {
        zeroGToken = IERC20(zeroGToken_);
    }

    receive() external payable {} // native 0G from unwrapping

    function setAllowedSender(uint64 chainSelector, address sender, bool ok) external onlyOwner {
        allowedSenders[chainSelector][sender] = ok;
        emit SenderAllowed(chainSelector, sender, ok);
    }

    function setUnwrap(bool v) external onlyOwner {
        unwrapToNative = v;
    }

    /// @notice Register (or change) an agent's payout wallet and release anything held for it.
    function setPayout(bytes32 agentId, address payout) external onlyOwner nonReentrant {
        payoutOf[agentId] = payout;
        emit PayoutSet(agentId, payout);
        uint256 amount = held[agentId];
        if (payout != address(0) && amount > 0) {
            held[agentId] = 0;
            _pay(bytes32(0), agentId, address(0), payout, amount, 0);
        }
    }

    function _ccipReceive(Client.Any2EVMMessage memory m) internal override nonReentrant {
        address sender = abi.decode(m.sender, (address));
        if (!allowedSenders[m.sourceChainSelector][sender]) revert UnknownSender(m.sourceChainSelector, sender);
        if (processed[m.messageId]) revert Duplicate();
        processed[m.messageId] = true;
        (bytes32 agentId, address subscriber,, uint64 until) = abi.decode(m.data, (bytes32, address, uint256, uint64));

        // Pay what actually arrived, never what the message claims.
        uint256 received;
        for (uint256 i; i < m.destTokenAmounts.length; ++i) {
            if (m.destTokenAmounts[i].token == address(zeroGToken)) received += m.destTokenAmounts[i].amount;
        }
        address payout = payoutOf[agentId];
        if (payout == address(0)) {
            held[agentId] += received;
            emit HireHeld(m.messageId, agentId, subscriber, received);
            return;
        }
        _pay(m.messageId, agentId, subscriber, payout, received, until);
    }

    function _pay(bytes32 messageId, bytes32 agentId, address subscriber, address payout, uint256 amount, uint64 until) internal {
        paidTotal[agentId] += amount;
        if (unwrapToNative) {
            IWrapped0G(address(zeroGToken)).withdraw(amount);
            (bool ok,) = payable(payout).call{value: amount}("");
            require(ok, "payout");
        } else {
            zeroGToken.safeTransfer(payout, amount);
        }
        emit HirePaid(messageId, agentId, subscriber, payout, amount, unwrapToNative, until);
    }
}
