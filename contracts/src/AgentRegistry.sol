// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IRiskGateView {
    function riskTier() external view returns (uint8);
    function mandate()
        external
        view
        returns (uint64, uint64, uint64, uint256, uint256, uint256 C, uint256, uint256, bytes32);
}

/// @title AgentRegistry
/// @notice Arena registry. Each agent posts a stake bond (slashed on provenance mismatch, so one operator
///         cannot cheaply flood the leaderboard), declares its risk tier (locked: read from its RiskGate,
///         which fixes it at deploy), and can be retired with an on-chain death certificate.
contract AgentRegistry is Ownable {
    enum Status {
        None,
        Alive,
        Retired
    }

    struct AgentRecord {
        address operator;
        address vault;
        address riskGate;
        address wallet;
        address arkivWallet; // the wallet whose ownedBy() proves Arkiv provenance
        uint8 tier;
        uint64 registeredAt;
        uint256 stake;
        Status status;
        string name;
        string strategy;
    }

    uint256 public minStake;
    mapping(bytes32 => AgentRecord) public agents;
    bytes32[] public agentIds;

    event AgentRegistered(bytes32 indexed agentId, string name, uint8 tier, address vault, address riskGate);
    event DeathCertificate(bytes32 indexed agentId, uint64 bornAt, uint64 diedAt, string epitaph);
    event Slashed(bytes32 indexed agentId, uint256 amount, string reason);

    constructor(uint256 minStake_, address owner_) Ownable(owner_) {
        minStake = minStake_;
    }

    function register(
        bytes32 agentId,
        string calldata name,
        string calldata strategy,
        address vault,
        address riskGate,
        address wallet,
        address arkivWallet
    ) external payable {
        require(agents[agentId].status == Status.None, "exists");
        require(msg.value >= minStake, "stake");
        uint8 tier = IRiskGateView(riskGate).riskTier();
        agents[agentId] = AgentRecord(
            msg.sender, vault, riskGate, wallet, arkivWallet, tier, uint64(block.timestamp), msg.value, Status.Alive, name, strategy
        );
        agentIds.push(agentId);
        emit AgentRegistered(agentId, name, tier, vault, riskGate);
    }

    /// @notice Retire an agent whose cushion is zero (its operator attests the compute reserve is spent too).
    ///         Losing is visible, which makes winning believable.
    function retire(bytes32 agentId, string calldata epitaph) external {
        AgentRecord storage a = agents[agentId];
        require(a.status == Status.Alive, "not alive");
        require(msg.sender == a.operator || msg.sender == owner(), "auth");
        (,,,,, uint256 C,,,) = IRiskGateView(a.riskGate).mandate();
        require(C == 0, "cushion > 0");
        a.status = Status.Retired;
        uint256 refund = a.stake;
        a.stake = 0;
        emit DeathCertificate(agentId, a.registeredAt, uint64(block.timestamp), epitaph);
        if (refund > 0) payable(a.operator).transfer(refund);
    }

    function slash(bytes32 agentId, uint256 amount, string calldata reason) external onlyOwner {
        AgentRecord storage a = agents[agentId];
        if (amount > a.stake) amount = a.stake;
        a.stake -= amount;
        emit Slashed(agentId, amount, reason);
        payable(owner()).transfer(amount);
    }

    function count() external view returns (uint256) {
        return agentIds.length;
    }
}
