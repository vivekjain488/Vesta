// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRiskGate} from "./interfaces/IRiskGate.sol";
import {IAgentWallet} from "./interfaces/IAgentWallet.sol";

/// @title AgentWallet
/// @notice The agent's trading wallet and Flash `funderAddress`. Because it has code, Flash validates order
///         signatures via EIP-1271 `isValidSignature`. It returns the magic value ONLY when:
///           (a) RiskGate has approved that exact EIP-712 digest and the approval is still live, and
///           (b) the signature is the proposer key's ECDSA signature over that digest (defence in depth).
///         The agent's key can propose and sign, but it can never move funds: tokens leave only to Flash's
///         allowance contract (allowance raised per approved order, capped at E by RiskGate) or back to the
///         vault. The wallet balance itself is the hard cap on losses.
contract AgentWallet is IERC1271, IAgentWallet, Ownable {
    using SafeERC20 for IERC20;

    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    address public vault;
    address public riskGate;
    address public proposer;
    /// @notice Flash's DefinitiveFlashAllowance (or Permit2) contract on this chain: the spender in
    ///         QuoteResponse.evm.approveTx. Confirm the address from a live quote on day one.
    address public flashSpender;
    /// @notice EIP-191 hashes of Flash cancel messages the proposer may sign. Cancels only ever REDUCE risk,
    ///         and each hash is derived on-chain from the canonical cancel text, so it can never collide with
    ///         an order digest that RiskGate has not approved.
    mapping(bytes32 => bool) public cancelHashes;

    event Wired(address vault, address riskGate, address proposer, address flashSpender);
    event Returned(address indexed token, uint256 amount);
    event AllowanceSet(address indexed token, uint256 allowance);
    event CancelApproved(string orderId, bytes32 hash);

    error OnlyVault();
    error OnlyRiskGate();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice One-shot wiring of vault and gate; spender/proposer can be rotated by the owner.
    function wire(address vault_, address riskGate_, address proposer_, address flashSpender_) external onlyOwner {
        require(vault == address(0), "wired");
        vault = vault_;
        riskGate = riskGate_;
        proposer = proposer_;
        flashSpender = flashSpender_;
        emit Wired(vault_, riskGate_, proposer_, flashSpender_);
    }

    function setProposer(address p) external onlyOwner {
        proposer = p;
    }

    function setFlashSpender(address s) external onlyOwner {
        flashSpender = s;
    }

    /// @notice Flash cancel message: "Definitive Flash v1 — Cancel Order\nOrder: <orderId>" (EIP-191 personal_sign).
    function cancelHash(string calldata orderId) public pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            abi.encodePacked(unicode"Definitive Flash v1 — Cancel Order\nOrder: ", orderId)
        );
    }

    function approveCancel(string calldata orderId) external returns (bytes32 h) {
        require(msg.sender == proposer || msg.sender == owner() || msg.sender == riskGate, "auth");
        h = cancelHash(orderId);
        cancelHashes[h] = true;
        emit CancelApproved(orderId, h);
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (!cancelHashes[hash] && !IRiskGate(riskGate).isApproved(hash)) return INVALID;
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError || rec != proposer) return INVALID;
        return MAGIC;
    }

    function returnToVault(address token, uint256 amount) external returns (uint256 sent) {
        if (msg.sender != vault) revert OnlyVault();
        uint256 bal = IERC20(token).balanceOf(address(this));
        sent = amount > bal ? bal : amount;
        if (sent > 0) IERC20(token).safeTransfer(vault, sent);
        emit Returned(token, sent);
    }

    function grantFlashAllowance(address token, uint256 amount, uint256 cap) external {
        if (msg.sender != riskGate) revert OnlyRiskGate();
        uint256 current = IERC20(token).allowance(address(this), flashSpender);
        uint256 next = current + amount;
        if (next > cap) next = cap;
        IERC20(token).forceApprove(flashSpender, next);
        emit AllowanceSet(token, next);
    }

    function revokeFlashAllowance(address token) external {
        if (msg.sender != riskGate) revert OnlyRiskGate();
        IERC20(token).forceApprove(flashSpender, 0);
        emit AllowanceSet(token, 0);
    }

    receive() external payable {}
}
