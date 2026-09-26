// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IArbGasInfo, IPonsV2BondingCurve, IPonsV2LaunchFactory} from "./interfaces/IPonsV2.sol";

interface IBalanceOf {
    function balanceOf(address account) external view returns (uint256);
}

/// @title FuelStation
/// @notice Gas tanks for Pons V2 tokens on Robinhood Chain.
///
/// Anyone can open a tank for a Pons V2 token and fill it with ETH. A buy of
/// that token routed through `buy` is refunded its own gas, L2 execution plus
/// the L1 data fee, from the tank, in the same transaction. The buyer needs
/// no special wallet: it is one ordinary payable call.
///
/// Safety model
///  - The station never takes arbitrary calldata. It buys only through the
///    bonding curve the official Pons factory reports for the tank's token,
///    so every refunded buy is a real trade on a curve nobody can self-deal on.
///  - A refund can never exceed the trade fee that buy paid to the curve
///    (Pons fee + creator tax). Draining a tank with wash buys therefore
///    costs the attacker at least as much as the tank loses.
///  - Per-buy and per-wallet-per-day caps are set by the sponsor.
///  - The protocol owner can set the deposit fee (capped at 5%), the treasury
///    and the $FUEL boost. It cannot touch, pause or redirect any tank.
contract FuelStation {
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;
    /// @notice Gas spent outside the measured window: the 21k intrinsic cost,
    /// calldata, and the bookkeeping and payout after the measurement.
    /// Calibrated against real receipts on anvil (see docs/CALIBRATION.md).
    uint256 public constant GAS_OVERHEAD = 50_000;
    /// @notice Extra cost of a wallet's first refund from a tank: its usage slot
    /// goes from zero to non-zero (22,100 gas instead of 5,000).
    uint256 public constant FIRST_REFUND_GAS = 17_100;
    /// @notice Gas the refund bookkeeping and payout need. Wallets estimate gas at a
    /// zero gas price, where no refund is due, so a naive estimate leaves too little;
    /// rather than run out of gas, such a buy simply goes through without a refund.
    uint256 public constant REFUND_GAS_RESERVE = 60_000;

    uint256 private constant BPS = 10_000;
    address private constant ARB_GAS_INFO = address(0x6C);

    struct Tank {
        address sponsor;
        uint16 tradeFeeBps; // curve fee + creator tax; both immutable on the curve, so cached once
        bool official; // sponsor was the token's deployer or creator-fee recipient when the tank opened
        bool paused;
        address token;
        address curve;
        uint128 balance;
        uint64 maxRefundPerBuy;
        uint64 dailyCapPerWallet;
    }

    struct Usage {
        uint64 day;
        uint192 used;
    }

    IPonsV2LaunchFactory public immutable factory;

    address public owner;
    address public treasury;
    uint16 public protocolFeeBps;
    address public fuelToken;
    uint256 public boostThreshold;

    uint256 public tankCount;
    mapping(uint256 id => Tank) public tanks;
    mapping(uint256 id => mapping(address wallet => Usage)) public usage;

    bool private transient locked;

    event TankOpened(uint256 indexed id, address indexed token, address indexed sponsor, bool official);
    event Refueled(uint256 indexed id, address indexed from, uint256 amount, uint256 protocolFee);
    event TankConfigured(uint256 indexed id, uint64 maxRefundPerBuy, uint64 dailyCapPerWallet);
    event TankPaused(uint256 indexed id, bool paused);
    event TankClosed(uint256 indexed id, address to, uint256 amount);
    event FueledBuy(uint256 indexed id, address indexed buyer, uint256 spent, uint256 tokensOut, uint256 refund);
    event OwnerChanged(address owner);
    event TreasuryChanged(address treasury);
    event ProtocolFeeChanged(uint16 bps);
    event BoostChanged(address fuelToken, uint256 threshold);

    error NotOwner();
    error NotSponsor();
    error UnknownTank();
    error NotAPonsToken();
    error UnsupportedQuote();
    error AlreadyGraduated();
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error TankOverflow();
    error TransferFailed();
    error Reentrancy();
    error UnexpectedEth();

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySponsor(uint256 id) {
        if (msg.sender != tanks[id].sponsor) revert NotSponsor();
        _;
    }

    constructor(IPonsV2LaunchFactory factory_, address owner_, address treasury_, uint16 protocolFeeBps_) {
        if (address(factory_) == address(0) || owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        factory = factory_;
        owner = owner_;
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
    }

    /// @notice The curve pays unspent ETH back to the station mid-buy; nothing else may send ETH here.
    receive() external payable {
        if (!locked) revert UnexpectedEth();
    }

    // ---------------------------------------------------------------- tanks

    /// @notice Opens a tank for a Pons V2 token that trades against native ETH
    /// and is still on its bonding curve. Any ETH sent is the first fill.
    function openTank(address token, uint64 maxRefundPerBuy, uint64 dailyCapPerWallet)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (!launch.exists || launch.token != token || launch.curve == address(0)) revert NotAPonsToken();
        if (launch.pairToken != address(0)) revert UnsupportedQuote();
        if (launch.phase != IPonsV2LaunchFactory.GraduationPhase.NotGraduated) revert AlreadyGraduated();

        IPonsV2BondingCurve curve = IPonsV2BondingCurve(launch.curve);
        uint256 tradeFeeBps = curve.feeBps() + curve.creatorTaxBps(); // Pons caps the sum at 20%
        if (tradeFeeBps > BPS) revert NotAPonsToken();

        id = ++tankCount;
        bool official = msg.sender == launch.deployer || msg.sender == launch.creatorFeeRecipient;
        tanks[id] = Tank({
            sponsor: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast) bounded by BPS just above
            tradeFeeBps: uint16(tradeFeeBps),
            official: official,
            paused: false,
            token: token,
            curve: launch.curve,
            balance: 0,
            maxRefundPerBuy: maxRefundPerBuy,
            dailyCapPerWallet: dailyCapPerWallet
        });
        emit TankOpened(id, token, msg.sender, official);
        emit TankConfigured(id, maxRefundPerBuy, dailyCapPerWallet);

        if (msg.value != 0) _deposit(id, msg.value);
    }

    /// @notice Adds ETH to any tank. Communities can fuel the coins they hold.
    function refuel(uint256 id) external payable nonReentrant {
        if (tanks[id].token == address(0)) revert UnknownTank();
        if (msg.value == 0) revert ZeroAmount();
        _deposit(id, msg.value);
    }

    function configure(uint256 id, uint64 maxRefundPerBuy, uint64 dailyCapPerWallet) external onlySponsor(id) {
        Tank storage t = tanks[id];
        t.maxRefundPerBuy = maxRefundPerBuy;
        t.dailyCapPerWallet = dailyCapPerWallet;
        emit TankConfigured(id, maxRefundPerBuy, dailyCapPerWallet);
    }

    function setPaused(uint256 id, bool paused) external onlySponsor(id) {
        tanks[id].paused = paused;
        emit TankPaused(id, paused);
    }

    /// @notice Pauses the tank and returns everything left in it to `to`.
    function close(uint256 id, address to) external nonReentrant onlySponsor(id) {
        if (to == address(0)) revert ZeroAddress();
        Tank storage t = tanks[id];
        uint256 amount = t.balance;
        t.balance = 0;
        t.paused = true;
        emit TankPaused(id, true);
        emit TankClosed(id, to, amount);
        if (amount != 0) _send(to, amount);
    }

    // ------------------------------------------------------------------ buy

    /// @notice Buys the tank's token on its Pons bonding curve with all of
    /// msg.value, sends the tokens to the caller, and refunds the caller's gas
    /// from the tank. A paused, empty or capped-out tank never blocks the buy;
    /// the refund is simply smaller or zero.
    /// @param minTokensOut Slippage bound, passed straight to the curve.
    /// @return tokensOut Tokens delivered to msg.sender.
    /// @return refund ETH paid back to msg.sender for gas.
    function buy(uint256 id, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut, uint256 refund)
    {
        uint256 gasStart = gasleft();
        Tank storage t = tanks[id];
        if (t.token == address(0)) revert UnknownTank();
        if (msg.value == 0) revert ZeroAmount();

        uint256 held = address(this).balance - msg.value;
        tokensOut = IPonsV2BondingCurve(t.curve).buy{value: msg.value}(msg.value, minTokensOut, msg.sender);
        uint256 unspent = address(this).balance - held; // a clamped final fill returns the rest
        uint256 spent = msg.value - unspent;

        if (!t.paused && gasleft() > REFUND_GAS_RESERVE) refund = _refund(t, id, spent, gasStart);

        emit FueledBuy(id, msg.sender, spent, tokensOut, refund);
        if (unspent + refund != 0) _send(msg.sender, unspent + refund);
    }

    /// @notice The most a buy of `spend` wei could be refunded right now, before gas price.
    function refundCap(uint256 id, address wallet, uint256 spend) external view returns (uint256 cap) {
        Tank storage t = tanks[id];
        if (t.paused) return 0;
        (cap,) = _cap(t, id, wallet, spend);
    }

    // ---------------------------------------------------------------- admin

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function setProtocolFee(uint16 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        protocolFeeBps = bps;
        emit ProtocolFeeChanged(bps);
    }

    /// @notice Wallets holding at least `threshold` of `fuelToken_` get double the daily cap.
    /// Set `fuelToken_` to zero to turn the boost off.
    function setBoost(address fuelToken_, uint256 threshold) external onlyOwner {
        fuelToken = fuelToken_;
        boostThreshold = threshold;
        emit BoostChanged(fuelToken_, threshold);
    }

    // ------------------------------------------------------------- internal

    function _deposit(uint256 id, uint256 amount) private {
        uint256 fee = (amount * protocolFeeBps) / BPS;
        Tank storage t = tanks[id];
        uint256 next = t.balance + amount - fee;
        if (next > type(uint128).max) revert TankOverflow();
        // forge-lint: disable-next-line(unsafe-typecast) checked on the line above
        t.balance = uint128(next);
        emit Refueled(id, msg.sender, amount - fee, fee);
        if (fee != 0) _send(treasury, fee);
    }

    function _refund(Tank storage t, uint256 id, uint256 spent, uint256 gasStart) private returns (uint256 refund) {
        uint256 gasUsed = gasStart - gasleft() + GAS_OVERHEAD;
        if (usage[id][msg.sender].day == 0) gasUsed += FIRST_REFUND_GAS;
        uint256 cost = gasUsed * _l2GasPrice() + _l1Fee();

        (uint256 cap, uint256 usedToday) = _cap(t, id, msg.sender, spent);
        refund = cost < cap ? cost : cap;
        if (refund == 0) return 0;

        // Both casts are safe: refund <= cap <= t.balance (a uint128), and
        // usedToday + refund <= 2 * dailyCapPerWallet (a uint64) fits in 192 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        t.balance -= uint128(refund);
        // forge-lint: disable-next-line(unsafe-typecast)
        usage[id][msg.sender] = Usage({day: _today(), used: uint192(usedToday + refund)});
    }

    /// @return cap Largest refund allowed for this buy.
    /// @return usedToday What `wallet` has already been refunded from this tank today.
    function _cap(Tank storage t, uint256 id, address wallet, uint256 spent)
        private
        view
        returns (uint256 cap, uint256 usedToday)
    {
        cap = (spent * t.tradeFeeBps) / BPS;
        if (t.maxRefundPerBuy < cap) cap = t.maxRefundPerBuy;
        if (t.balance < cap) cap = t.balance;

        Usage memory u = usage[id][wallet];
        usedToday = u.day == _today() ? u.used : 0;
        uint256 daily = _boosted(wallet) ? uint256(t.dailyCapPerWallet) * 2 : t.dailyCapPerWallet;
        uint256 left = daily > usedToday ? daily - usedToday : 0;
        if (left < cap) cap = left;
    }

    function _boosted(address wallet) private view returns (bool) {
        address token = fuelToken;
        if (token == address(0)) return false;
        // A misbehaving token must never be able to break buys.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IBalanceOf.balanceOf, (wallet)));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) >= boostThreshold;
    }

    /// @dev What the buyer actually pays per unit of L2 gas. Arbitrum charges the
    /// base fee and ignores tips, so a padded gas price is never reimbursed.
    function _l2GasPrice() private view returns (uint256) {
        return tx.gasprice < block.basefee ? tx.gasprice : block.basefee;
    }

    /// @dev L1 data fee for this transaction from the ArbGasInfo precompile; zero off Arbitrum.
    function _l1Fee() private view returns (uint256) {
        (bool ok, bytes memory ret) = ARB_GAS_INFO.staticcall(abi.encodeCall(IArbGasInfo.getCurrentTxL1GasFees, ()));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
