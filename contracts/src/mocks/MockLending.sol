// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISafeLeg} from "../interfaces/ISafeLeg.sol";

/// @title MockLending
/// @notice Testnet stand-in for the safe leg. Accrues simple interest at `rateBps` per year, compounded on
///         every touch. `timeMultiplier` accelerates time for the demo (DISCLOSED in the README: a 1x
///         multiplier is real-time; the demo uses an accelerated value so yield is visible on stage).
///         Interest is paid out of a pre-funded `yieldReserve` (seeded once at setup, disclosed), so the mock
///         can never mint value out of nothing.
contract MockLending is ISafeLeg, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public rateBps; // APY in bps, e.g. 450 = 4.5%
    uint256 public timeMultiplier = 1;
    uint256 public yieldReserve;

    struct Position {
        uint256 balance; // principal + capitalised interest
        uint64 lastAccrual;
    }

    mapping(address => Position) public positions;

    event RateSet(uint256 rateBps, uint256 timeMultiplier);
    event ReserveFunded(address indexed from, uint256 amount);

    constructor(address token_, uint256 rateBps_, address owner_) Ownable(owner_) {
        token = IERC20(token_);
        rateBps = rateBps_;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function setRate(uint256 rateBps_, uint256 timeMultiplier_) external onlyOwner {
        require(timeMultiplier_ >= 1 && timeMultiplier_ <= 100_000, "mult");
        rateBps = rateBps_;
        timeMultiplier = timeMultiplier_;
        emit RateSet(rateBps_, timeMultiplier_);
    }

    function fundReserve(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        yieldReserve += amount;
        emit ReserveFunded(msg.sender, amount);
    }

    function _pending(Position memory p) internal view returns (uint256) {
        if (p.balance == 0 || p.lastAccrual == 0) return 0;
        uint256 dt = (block.timestamp - p.lastAccrual) * timeMultiplier;
        uint256 interest = (p.balance * rateBps * dt) / (10_000 * 365 days);
        return interest > yieldReserve ? yieldReserve : interest;
    }

    function _accrue(address account) internal {
        Position storage p = positions[account];
        uint256 interest = _pending(p);
        if (interest > 0) {
            yieldReserve -= interest;
            p.balance += interest;
        }
        p.lastAccrual = uint64(block.timestamp);
    }

    function deposit(uint256 amount) external {
        _accrue(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        positions[msg.sender].balance += amount;
    }

    function withdraw(uint256 amount) external returns (uint256 out) {
        _accrue(msg.sender);
        Position storage p = positions[msg.sender];
        out = amount > p.balance ? p.balance : amount;
        p.balance -= out;
        token.safeTransfer(msg.sender, out);
    }

    function totalValue(address account) external view returns (uint256) {
        Position memory p = positions[account];
        return p.balance + _pending(p);
    }
}
