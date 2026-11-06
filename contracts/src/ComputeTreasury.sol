// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Client} from "./ccip/Client.sol";
import {CCIPReceiver} from "./ccip/CCIPReceiver.sol";

interface IWrappedNative {
    function withdraw(uint256) external;
}

interface IComputeLedger {
    function depositFundFor(address recipient) external payable;
}

/// @title ComputeTreasury (deployed on 0G Chain)
/// @notice CCIP receiver that credits each agent with the native-0G harvested from its vaults. The agent's
///         runtime calls fundLedger(), which atomically unwraps W0G and deposits for the operator's 0G
///         ledger using depositFundFor(). Legacy withdrawals are retained for local simulation. Funding is
///         capped per day: that cap is one of the three
///         spend caps the 0G track requires.
///         Seed reserve (the "day-one cold start" pool) arrives once via `seed()` and is disclosed in the
///         README. Every later credit must arrive via CCIP from an allow-listed HarvestRouter.
contract ComputeTreasury is CCIPReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable zeroGToken; // the CCT as delivered by the CCIP token pool on 0G Chain
    bool public unwrapToNative; // set if the pool releases a wrapped-native ERC-20
    IComputeLedger public ledgerManager;
    mapping(bytes32 => mapping(bytes32 => bool)) public fundedOperations;

    struct Agent {
        address operator; // agent runtime wallet that owns the 0G compute ledger
        uint256 dailyCap; // max 0G withdrawable per day
        uint256 credited;
        uint256 withdrawn;
        uint256 seeded;
        uint64 dayStart;
        uint256 withdrawnToday;
    }

    mapping(bytes32 => Agent) public agents;
    mapping(uint64 => mapping(address => bool)) public allowedSenders; // sourceChainSelector => HarvestRouter
    mapping(bytes32 => bool) public processed; // messageId
    mapping(bytes32 => mapping(uint64 => bool)) public epochCredited; // agentId => epoch

    event AgentConfigured(bytes32 indexed agentId, address operator, uint256 dailyCap);
    event Seeded(bytes32 indexed agentId, address indexed from, uint256 amount);
    event HarvestCredited(
        bytes32 indexed messageId, bytes32 indexed agentId, uint64 epoch, uint64 sourceChain, uint256 amount
    );
    event LedgerFunded(bytes32 indexed agentId, address indexed operator, uint256 amount);
    event LedgerDeposited(bytes32 indexed agentId, bytes32 indexed operationId, address indexed operator, uint256 amount);
    event LedgerManagerSet(address ledgerManager);

    error UnknownSender(uint64 chain, address sender);
    error Duplicate();
    error OverDailyCap(uint256 requested, uint256 remaining);
    error NotOperator();

    constructor(address router_, address zeroGToken_, address owner_) CCIPReceiver(router_) Ownable(owner_) {
        zeroGToken = IERC20(zeroGToken_);
    }

    function setAllowedSender(uint64 chainSelector, address sender, bool ok) external onlyOwner {
        allowedSenders[chainSelector][sender] = ok;
    }

    function setUnwrap(bool v) external onlyOwner {
        unwrapToNative = v;
    }

    function setLedgerManager(address ledger) external onlyOwner {
        require(ledger.code.length > 0, "ledger contract required");
        ledgerManager = IComputeLedger(ledger);
        emit LedgerManagerSet(ledger);
    }

    function configureAgent(bytes32 agentId, address operator, uint256 dailyCap) external onlyOwner {
        Agent storage a = agents[agentId];
        a.operator = operator;
        a.dailyCap = dailyCap;
        emit AgentConfigured(agentId, operator, dailyCap);
    }

    function balanceOf(bytes32 agentId) public view returns (uint256) {
        Agent storage a = agents[agentId];
        return a.credited + a.seeded - a.withdrawn;
    }

    /// @notice One-time, disclosed seed for the cold-start hibernation reserve.
    function seed(bytes32 agentId, uint256 amount) external nonReentrant {
        zeroGToken.safeTransferFrom(msg.sender, address(this), amount);
        agents[agentId].seeded += amount;
        emit Seeded(agentId, msg.sender, amount);
    }

    function _ccipReceive(Client.Any2EVMMessage memory m) internal override {
        address sender = abi.decode(m.sender, (address));
        if (!allowedSenders[m.sourceChainSelector][sender]) revert UnknownSender(m.sourceChainSelector, sender);
        if (processed[m.messageId]) revert Duplicate();
        processed[m.messageId] = true;
        (bytes32 agentId, uint256 amount, uint64 epoch) = abi.decode(m.data, (bytes32, uint256, uint64));
        if (epochCredited[agentId][epoch]) revert Duplicate();
        epochCredited[agentId][epoch] = true;

        // Credit what actually arrived, never what the message claims.
        uint256 received;
        for (uint256 i; i < m.destTokenAmounts.length; ++i) {
            if (m.destTokenAmounts[i].token == address(zeroGToken)) received += m.destTokenAmounts[i].amount;
        }
        if (received < amount) amount = received;
        agents[agentId].credited += amount;
        emit HarvestCredited(m.messageId, agentId, epoch, m.sourceChainSelector, amount);
    }

    /// @notice Agent runtime pulls 0G to its own wallet, then deposits it into its 0G compute ledger.
    function withdrawForLedger(bytes32 agentId, uint256 amount) external nonReentrant {
        Agent storage a = _debit(agentId, amount);
        if (unwrapToNative) {
            IWrappedNative(address(zeroGToken)).withdraw(amount);
            (bool ok,) = payable(a.operator).call{value: amount}("");
            require(ok, "native send");
        } else {
            zeroGToken.safeTransfer(a.operator, amount);
        }
        emit LedgerFunded(agentId, a.operator, amount);
    }

    /// @notice One atomic funding transaction: an unwrap/deposit failure rolls back credit and daily caps.
    ///         Reusing an operation ID can never deposit twice, including after an unknown RPC timeout.
    function fundLedger(bytes32 agentId, bytes32 operationId, uint256 amount) external nonReentrant {
        require(operationId != bytes32(0), "operation required");
        if (fundedOperations[agentId][operationId]) revert Duplicate();
        require(unwrapToNative && address(ledgerManager) != address(0), "native ledger route not configured");
        Agent storage a = _debit(agentId, amount);
        fundedOperations[agentId][operationId] = true;
        IWrappedNative(address(zeroGToken)).withdraw(amount);
        ledgerManager.depositFundFor{value: amount}(a.operator);
        emit LedgerDeposited(agentId, operationId, a.operator, amount);
    }

    function _debit(bytes32 agentId, uint256 amount) internal returns (Agent storage a) {
        require(amount > 0, "amount required");
        a = agents[agentId];
        if (msg.sender != a.operator) revert NotOperator();
        if (block.timestamp >= a.dayStart + 1 days) {
            a.dayStart = uint64(block.timestamp);
            a.withdrawnToday = 0;
        }
        uint256 remaining = a.dailyCap > a.withdrawnToday ? a.dailyCap - a.withdrawnToday : 0;
        if (amount > remaining) revert OverDailyCap(amount, remaining);
        require(amount <= balanceOf(agentId), "balance");
        a.withdrawnToday += amount;
        a.withdrawn += amount;
    }

    receive() external payable {}
}
