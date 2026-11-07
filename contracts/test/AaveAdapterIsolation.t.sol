// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
contract AdapterPoolMock {
    MockERC20 public token; MockERC20 public receipt;
    constructor(MockERC20 t, MockERC20 a) { token = t; receipt = a; }
    function supply(address asset, uint256 amount, address beneficiary, uint16) external {
        require(asset == address(token)); token.transferFrom(msg.sender, address(this), amount); receipt.mint(beneficiary, amount);
    }
    function withdraw(address asset, uint256 amount, address beneficiary) external returns (uint256) {
        require(asset == address(token)); receipt.burn(msg.sender, amount); token.transfer(beneficiary, amount); return amount;
    }
}
contract AaveAdapterIsolationTest is Test {
    function testSeparateVaultsCanDepositAndWithdrawWithoutAccessToEachOther() public {
        MockERC20 token = new MockERC20("USD", "USD", 6); MockERC20 aToken = new MockERC20("aUSD", "aUSD", 6);
        AdapterPoolMock pool = new AdapterPoolMock(token, aToken);
        address vaultA = address(0xA11CE); address vaultB = address(0xB0B);
        AaveV3Adapter a = new AaveV3Adapter(address(pool), address(token), address(aToken), vaultA);
        AaveV3Adapter b = new AaveV3Adapter(address(pool), address(token), address(aToken), vaultB);
        token.mint(vaultA, 100e6); token.mint(vaultB, 200e6);
        vm.startPrank(vaultA); token.approve(address(a), 100e6); a.deposit(100e6); vm.stopPrank();
        vm.startPrank(vaultB); token.approve(address(b), 200e6); b.deposit(200e6);
        vm.expectRevert(AaveV3Adapter.OnlyVault.selector); a.withdraw(1); vm.stopPrank();
        assertEq(a.totalValue(vaultA), 100e6); assertEq(b.totalValue(vaultB), 200e6);
        vm.prank(vaultA); a.withdraw(100e6); vm.prank(vaultB); b.withdraw(200e6);
        assertEq(token.balanceOf(vaultA), 100e6); assertEq(token.balanceOf(vaultB), 200e6);
    }
}
