// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FuelStation} from "../src/FuelStation.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2.sol";
import {MockArbGasInfo, MockCurve, MockFactory, MockToken, RejectingBuyer} from "./mocks/PonsMocks.sol";

contract FuelStationTest is Test {
    FuelStation station;
    MockFactory factory;
    MockToken token;
    MockCurve curve;
    MockToken fuel;
    MockArbGasInfo arbGasInfo = MockArbGasInfo(address(0x6C));

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address fan = makeAddr("fan");
    address buyer = makeAddr("buyer");

    uint64 constant MAX_PER_BUY = 0.001 ether;
    uint64 constant DAILY_CAP = 0.003 ether;
    uint256 constant GAS_PRICE = 1 gwei;

    function setUp() public {
        factory = new MockFactory();
        token = new MockToken();
        curve = new MockCurve(token, 100, 100); // 1% Pons fee + 1% creator tax
        factory.list(
            address(token),
            address(curve),
            creator,
            creator,
            address(0),
            IPonsV2LaunchFactory.GraduationPhase.NotGraduated
        );
        station = new FuelStation(IPonsV2LaunchFactory(address(factory)), owner, treasury, 200); // 2% deposit fee

        vm.etch(address(0x6C), address(new MockArbGasInfo()).code);
        arbGasInfo.setL1Fee(20_000 gwei);

        vm.fee(GAS_PRICE);
        vm.txGasPrice(GAS_PRICE);
        vm.deal(creator, 100 ether);
        vm.deal(fan, 100 ether);
        vm.deal(buyer, 100 ether);
    }

    function _openTank(uint256 fill) internal returns (uint256 id) {
        vm.prank(creator);
        id = station.openTank{value: fill}(address(token), MAX_PER_BUY, DAILY_CAP);
    }

    function _tankBalance(uint256 id) internal view returns (uint256 balance) {
        (,,,,,, balance,,) = station.tanks(id);
    }

    // ------------------------------------------------------------ opening

    function test_openTank_marksTheCreatorOfficial_andTakesTheProtocolFee() public {
        uint256 id = _openTank(1 ether);
        (address sponsor, uint16 tradeFeeBps, bool official,, address tkn, address crv,,,) = station.tanks(id);
        assertEq(sponsor, creator);
        assertEq(tradeFeeBps, 200);
        assertTrue(official);
        assertEq(tkn, address(token));
        assertEq(crv, address(curve));
        assertEq(_tankBalance(id), 0.98 ether);
        assertEq(treasury.balance, 0.02 ether);
    }

    function test_openTank_byAFanIsNotOfficial() public {
        vm.prank(fan);
        uint256 id = station.openTank(address(token), MAX_PER_BUY, DAILY_CAP);
        (,, bool official,,,,,,) = station.tanks(id);
        assertFalse(official);
    }

    function test_openTank_rejectsNonPonsTokens() public {
        vm.expectRevert(FuelStation.NotAPonsToken.selector);
        station.openTank(makeAddr("random"), MAX_PER_BUY, DAILY_CAP);
    }

    function test_openTank_rejectsStockPairedCurves() public {
        MockToken stockPaired = new MockToken();
        factory.list(
            address(stockPaired),
            address(curve),
            creator,
            creator,
            makeAddr("NVDA"),
            IPonsV2LaunchFactory.GraduationPhase.NotGraduated
        );
        vm.expectRevert(FuelStation.UnsupportedQuote.selector);
        station.openTank(address(stockPaired), MAX_PER_BUY, DAILY_CAP);
    }

    function test_openTank_rejectsGraduatedTokens() public {
        MockToken graduated = new MockToken();
        factory.list(
            address(graduated),
            address(curve),
            creator,
            creator,
            address(0),
            IPonsV2LaunchFactory.GraduationPhase.PoolCreated
        );
        vm.expectRevert(FuelStation.AlreadyGraduated.selector);
        station.openTank(address(graduated), MAX_PER_BUY, DAILY_CAP);
    }

    function test_anyoneCanRefuel() public {
        uint256 id = _openTank(0);
        vm.prank(fan);
        station.refuel{value: 1 ether}(id);
        assertEq(_tankBalance(id), 0.98 ether);
    }

    // ---------------------------------------------------------------- buys

    function test_buy_deliversTokens_andRefundsGasFromTheTank() public {
        uint256 id = _openTank(1 ether);
        uint256 before = buyer.balance;

        vm.fee(GAS_PRICE);
        vm.txGasPrice(GAS_PRICE);
        vm.prank(buyer);
        (uint256 tokensOut, uint256 refund) = station.buy{value: 0.1 ether}(id, 0);

        assertEq(token.balanceOf(buyer), tokensOut);
        assertGt(tokensOut, 0);
        assertGt(refund, 20_000 gwei, "covers the L1 fee plus L2 execution");
        assertLe(refund, MAX_PER_BUY);
        assertEq(buyer.balance, before - 0.1 ether + refund);
        assertEq(_tankBalance(id), 0.98 ether - refund);
        assertEq(address(station).balance, _tankBalance(id), "station holds exactly the tanks");
    }

    function test_buy_refundNeverExceedsTheTradeFeePaid() public {
        uint256 id = _openTank(1 ether);
        arbGasInfo.setL1Fee(0.5 ether); // absurd L1 fee, e.g. from padded calldata

        vm.prank(buyer);
        (, uint256 refund) = station.buy{value: 0.01 ether}(id, 0);
        assertEq(refund, 0.0002 ether, "2% of 0.01 ETH");
    }

    function test_buy_refundIsCappedPerBuy() public {
        uint256 id = _openTank(1 ether);
        arbGasInfo.setL1Fee(0.5 ether);

        vm.prank(buyer);
        (, uint256 refund) = station.buy{value: 1 ether}(id, 0);
        assertEq(refund, MAX_PER_BUY);
    }

    function test_buy_dailyCapPerWallet_resetsNextDay() public {
        uint256 id = _openTank(1 ether);
        arbGasInfo.setL1Fee(0.5 ether);

        vm.startPrank(buyer);
        uint256 total;
        for (uint256 i; i < 4; i++) {
            (, uint256 refund) = station.buy{value: 1 ether}(id, 0);
            total += refund;
        }
        assertEq(total, DAILY_CAP, "three full refunds, then nothing");

        vm.warp(block.timestamp + 1 days);
        (, uint256 tomorrow) = station.buy{value: 1 ether}(id, 0);
        assertEq(tomorrow, MAX_PER_BUY);
        vm.stopPrank();
    }

    function test_buy_fuelHoldersGetDoubleDailyCap() public {
        fuel = new MockToken();
        vm.prank(owner);
        station.setBoost(address(fuel), 1_000e18);
        fuel.mint(buyer, 1_000e18);

        uint256 id = _openTank(1 ether);
        arbGasInfo.setL1Fee(0.5 ether);
        assertEq(station.refundCap(id, buyer, 100 ether), MAX_PER_BUY);

        vm.startPrank(buyer);
        uint256 total;
        for (uint256 i; i < 8; i++) {
            (, uint256 refund) = station.buy{value: 1 ether}(id, 0);
            total += refund;
        }
        vm.stopPrank();
        assertEq(total, 2 * DAILY_CAP);
    }

    function test_buy_aBrokenFuelTokenNeverBlocksBuys() public {
        vm.prank(owner);
        station.setBoost(address(curve), 1); // has no balanceOf
        uint256 id = _openTank(1 ether);
        vm.prank(buyer);
        (uint256 tokensOut,) = station.buy{value: 0.1 ether}(id, 0);
        assertGt(tokensOut, 0);
    }

    function test_buy_returnsUnspentEthOnAClampedFill() public {
        uint256 id = _openTank(1 ether);
        curve.setSellable(0.049 ether * 1_000_000); // exactly 0.05 ETH gross at a 2% fee
        uint256 before = buyer.balance;

        vm.prank(buyer);
        (uint256 tokensOut, uint256 refund) = station.buy{value: 1 ether}(id, 0);

        assertEq(tokensOut, 0.049 ether * 1_000_000);
        uint256 spent = before + refund - buyer.balance;
        assertEq(spent, 0.05 ether);
        assertLe(refund, (spent * 200) / 10_000, "fee cap uses what was spent, not what was sent");
        assertEq(address(station).balance, _tankBalance(id));
    }

    function test_buy_pausedOrEmptyTankStillBuys_withoutRefund() public {
        uint256 id = _openTank(1 ether);
        vm.prank(creator);
        station.setPaused(id, true);
        vm.prank(buyer);
        (uint256 tokensOut, uint256 refund) = station.buy{value: 0.1 ether}(id, 0);
        assertGt(tokensOut, 0);
        assertEq(refund, 0);

        uint256 empty = _openTank(0);
        vm.prank(buyer);
        (, uint256 none) = station.buy{value: 0.1 ether}(empty, 0);
        assertEq(none, 0);
    }

    function test_buy_bubblesCurveSlippageErrors() public {
        uint256 id = _openTank(1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(MockCurve.SlippageExceeded.selector, 0.098 ether * 1_000_000, type(uint128).max)
        );
        station.buy{value: 0.1 ether}(id, type(uint128).max);
    }

    function test_buy_revertsWhenTheBuyerCannotReceiveTheRefund() public {
        uint256 id = _openTank(1 ether);
        RejectingBuyer contractBuyer = new RejectingBuyer();
        vm.expectRevert(FuelStation.TransferFailed.selector);
        contractBuyer.buy{value: 0.1 ether}(address(station), id);
    }

    function test_buy_aTightGasLimitSkipsTheRefundInsteadOfFailing() public {
        uint256 id = _openTank(1 ether);
        uint256 snapshot = vm.snapshotState();
        vm.fee(0);
        vm.txGasPrice(0);
        vm.prank(buyer);
        uint256 before = gasleft();
        station.buy{value: 0.1 ether}(id, 0); // what a wallet's zero-price estimate sees
        uint256 estimate = before - gasleft();
        vm.revertToState(snapshot);

        vm.fee(GAS_PRICE);
        vm.txGasPrice(GAS_PRICE);
        vm.prank(buyer);
        (uint256 tokensOut, uint256 refund) = station.buy{value: 0.1 ether, gas: estimate}(id, 0);
        assertGt(tokensOut, 0);
        assertEq(refund, 0);
    }

    function test_buy_unknownTank() public {
        vm.prank(buyer);
        vm.expectRevert(FuelStation.UnknownTank.selector);
        station.buy{value: 0.1 ether}(42, 0);
    }

    // ------------------------------------------------------------- sponsor

    function test_onlySponsorManagesTheTank() public {
        uint256 id = _openTank(1 ether);
        vm.startPrank(fan);
        vm.expectRevert(FuelStation.NotSponsor.selector);
        station.configure(id, 1, 1);
        vm.expectRevert(FuelStation.NotSponsor.selector);
        station.setPaused(id, true);
        vm.expectRevert(FuelStation.NotSponsor.selector);
        station.close(id, fan);
        vm.stopPrank();
    }

    function test_close_returnsTheRest_andPauses() public {
        uint256 id = _openTank(1 ether);
        address vault = makeAddr("vault");
        vm.prank(creator);
        station.close(id, vault);
        assertEq(vault.balance, 0.98 ether);
        assertEq(_tankBalance(id), 0);
        (,,, bool paused,,,,,) = station.tanks(id);
        assertTrue(paused);
    }

    // --------------------------------------------------------------- admin

    function test_ownerCannotExceedTheFeeCeiling() public {
        vm.prank(owner);
        vm.expectRevert(FuelStation.FeeTooHigh.selector);
        station.setProtocolFee(501);
    }

    function test_onlyOwnerAdministers() public {
        vm.startPrank(fan);
        vm.expectRevert(FuelStation.NotOwner.selector);
        station.setProtocolFee(0);
        vm.expectRevert(FuelStation.NotOwner.selector);
        station.setTreasury(fan);
        vm.expectRevert(FuelStation.NotOwner.selector);
        station.setBoost(address(0), 0);
        vm.expectRevert(FuelStation.NotOwner.selector);
        station.setOwner(fan);
        vm.stopPrank();
    }

    function test_strayEthIsRejected() public {
        vm.prank(fan);
        (bool ok,) = address(station).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_refundIsBoundedByFeeCapsAndTank(uint96 value, uint64 l1Fee, uint64 fill) public {
        value = uint96(bound(value, 1e9, 50 ether));
        uint256 id = _openTank(bound(fill, 0, 10 ether));
        arbGasInfo.setL1Fee(l1Fee);
        uint256 tankBefore = _tankBalance(id);

        vm.prank(buyer);
        (, uint256 refund) = station.buy{value: value}(id, 0);

        assertLe(refund, (uint256(value) * 200) / 10_000);
        assertLe(refund, MAX_PER_BUY);
        assertLe(refund, tankBefore);
        assertEq(address(station).balance, _tankBalance(id));
    }
}
