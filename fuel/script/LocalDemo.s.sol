// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FuelStation} from "../src/FuelStation.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2.sol";
import {MockCurve, MockFactory, MockToken} from "../test/mocks/PonsMocks.sol";

/// Local end-to-end playground on anvil: a mock Pons launch, a station and one filled tank.
///   anvil &
///   forge script script/LocalDemo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///   open web/index.html?station=<printed>&rpc=http://127.0.0.1:8545&chainId=31337
contract LocalDemo is Script {
    function run() external {
        vm.startBroadcast();
        address me = msg.sender;
        MockToken token = new MockToken();
        MockCurve curve = new MockCurve(token, 100, 100);
        MockFactory factory = new MockFactory();
        factory.list(
            address(token), address(curve), me, me, address(0), IPonsV2LaunchFactory.GraduationPhase.NotGraduated
        );
        FuelStation station = new FuelStation(IPonsV2LaunchFactory(address(factory)), me, me, 200);
        station.openTank{value: 1 ether}(address(token), 0.001 ether, 0.005 ether);
        vm.stopBroadcast();

        console.log("station", address(station));
        console.log("token", address(token));
    }
}
