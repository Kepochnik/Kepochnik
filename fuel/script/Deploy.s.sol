// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FuelStation} from "../src/FuelStation.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2.sol";

/// forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
///   env: OWNER, TREASURY, PROTOCOL_FEE_BPS (optional, default 200)
contract Deploy is Script {
    /// Official Pons V2 launch factory (github.com/ponsdotdev/ponsfamily README).
    address constant PONS_V2_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external returns (FuelStation station) {
        require(block.chainid == 4663, "not Robinhood Chain");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        uint16 feeBps = uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(200)));

        vm.startBroadcast();
        station = new FuelStation(IPonsV2LaunchFactory(PONS_V2_FACTORY), owner, treasury, feeBps);
        vm.stopBroadcast();

        console.log("FuelStation", address(station));
    }
}
