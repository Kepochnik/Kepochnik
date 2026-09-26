// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of Pons V2 that FuelStation relies on.
/// Source: github.com/ponsdotdev/ponsfamily, contractsV2/src/v2 (commit 162310f).
interface IPonsV2LaunchFactory {
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

interface IPonsV2BondingCurve {
    /// @dev Native-quote curves require msg.value == quoteIn. Unspent quote on a
    /// clamped final fill is sent back to msg.sender.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);

    function feeBps() external view returns (uint256);

    function creatorTaxBps() external view returns (uint256);
}

/// @notice Arbitrum precompile; Robinhood Chain is an Arbitrum Orbit chain.
interface IArbGasInfo {
    /// @return The L1 data fee, in wei, charged to the current transaction.
    function getCurrentTxL1GasFees() external view returns (uint256);
}
