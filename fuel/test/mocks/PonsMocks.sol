// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPonsV2LaunchFactory} from "../../src/interfaces/IPonsV2.sol";

contract MockToken {
    string public constant symbol = "FROG";
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Mirrors the parts of PonsV2BondingCurve.buy that FuelStation depends on:
/// native quote with msg.value == quoteIn, fee + tax on the quote leg, the
/// price-bound slippage check, and a clamped final fill that refunds the
/// unspent quote to msg.sender.
contract MockCurve {
    error NativeValueMismatch(uint256 value, uint256 amount);
    error SlippageExceeded(uint256 tokensOut, uint256 minTokensOut);

    MockToken public immutable token;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public tokensPerEth = 1_000_000;
    uint256 public sellable = type(uint256).max;

    constructor(MockToken token_, uint256 feeBps_, uint256 creatorTaxBps_) {
        token = token_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
    }

    function setSellable(uint256 amount) external {
        sellable = amount;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (msg.value != quoteIn) revert NativeValueMismatch(msg.value, quoteIn);
        uint256 spent = quoteIn;
        uint256 net = spent - (spent * (feeBps + creatorTaxBps)) / 10_000;
        tokensOut = net * tokensPerEth;
        if (tokensOut > sellable) {
            tokensOut = sellable;
            net = sellable / tokensPerEth;
            spent = (net * 10_000) / (10_000 - feeBps - creatorTaxBps);
        }
        if (spent * minTokensOut > quoteIn * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        token.mint(recipient, tokensOut);
        if (quoteIn > spent) {
            (bool ok,) = msg.sender.call{value: quoteIn - spent}("");
            require(ok, "refund failed");
        }
    }
}

contract MockFactory {
    mapping(address => IPonsV2LaunchFactory.LaunchedToken) private launches;

    function list(
        address token,
        address curve,
        address deployer,
        address creatorFeeRecipient,
        address pairToken,
        IPonsV2LaunchFactory.GraduationPhase phase
    ) external {
        IPonsV2LaunchFactory.LaunchedToken storage l = launches[token];
        l.token = token;
        l.curve = curve;
        l.deployer = deployer;
        l.creatorFeeRecipient = creatorFeeRecipient;
        l.pairToken = pairToken;
        l.phase = phase;
        l.exists = true;
    }

    function getLaunchedToken(address token) external view returns (IPonsV2LaunchFactory.LaunchedToken memory) {
        return launches[token];
    }
}

/// @dev Stands in for the ArbGasInfo precompile at 0x6C.
contract MockArbGasInfo {
    uint256 public l1Fee;

    function setL1Fee(uint256 fee) external {
        l1Fee = fee;
    }

    function getCurrentTxL1GasFees() external view returns (uint256) {
        return l1Fee;
    }
}

contract RejectingBuyer {
    function buy(address station, uint256 id) external payable {
        (bool ok, bytes memory ret) =
            station.call{value: msg.value}(abi.encodeWithSignature("buy(uint256,uint256)", id, 0));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
    // No receive(): refunds to this contract fail.
}
