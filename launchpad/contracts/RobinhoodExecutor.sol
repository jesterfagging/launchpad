// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface IPonsFactory {
    struct Launch {
        address token; address curve; address deployer; address creatorFeeRecipient;
        address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing;
        uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote;
        uint256 sweptTokens; uint256 sweptAt; bool exists;
    }
    function getLaunchedToken(address) external view returns (Launch memory);
}
interface IPonsCurve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function factory() external view returns (address);
    function buy(uint256, uint256, address) external payable returns (uint256);
    function sell(uint256, uint256, address) external returns (uint256);
}
interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}
interface IV2Factory { function getPair(address, address) external view returns (address); }
interface IV2Router {
    function factory() external view returns (address);
    function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) external returns (uint256,uint256);
}
interface IV3Positions {
    struct Decrease { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct Collect { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function ownerOf(uint256) external view returns (address);
    function decreaseLiquidity(Decrease calldata) external payable returns (uint256,uint256);
    function collect(Collect calldata) external payable returns (uint256,uint256);
}
interface IUniversalRouter { function execute(bytes calldata, bytes[] calldata, uint256) external payable; }
interface IPermit2 { function approve(address, address, uint160, uint48) external; }
interface IWeth { function deposit() external payable; function withdraw(uint256) external; }

/// @notice Atomic Pons trades and Uniswap LP withdrawals with a native-ETH fee.
/// No owner, upgrades, arbitrary calls, persistent token/NFT custody or withdrawals.
/// The caller supplies the fee the launchpad displays; this is not an oracle contract.
contract RobinhoodExecutor {
    address public constant universalRouter = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address public constant permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant weth = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    struct EthTrade { address token; bool buy; bool curve; uint256 amount; uint256 minimum; address feeRecipient; uint24 feePpm; }
    struct Hop { uint8 version; address input; address output; uint24 fee; int24 tickSpacing; address hooks; uint256 minimum; }
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct V4Swap { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }
    address public immutable ponsFactory;
    address public immutable v2Router;
    address public immutable v3PositionManager;
    uint256 private entered;
    error InvalidInput(); error TransferFailed(); error Reentered(); error Expired();
    event PlatformFee(address indexed wallet, address indexed recipient, uint256 amount, bytes4 operation);
    event CurveTraded(address indexed wallet, address indexed token, bool buy, uint256 inputSpent, uint256 output);
    event EthTraded(address indexed wallet, address indexed token, bool buy, uint256 inputSpent, uint256 output, uint256 feeEth);
    modifier lock(uint256 deadline) {
        if (entered != 0) revert Reentered();
        if (block.timestamp > deadline) revert Expired();
        entered = 1; _; entered = 0;
    }
    constructor(address ponsFactory_, address v2Router_, address v3PositionManager_) {
        if (block.chainid != 4663 || ponsFactory_.code.length == 0 || v2Router_.code.length == 0 || v3PositionManager_.code.length == 0) revert InvalidInput();
        ponsFactory = ponsFactory_; v2Router = v2Router_; v3PositionManager = v3PositionManager_;
    }
    receive() external payable {}
    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = to.call{value: amount}(""); if (!success) revert TransferFailed();
    }
    function _tokenCall(address token, bytes memory data) private {
        if (token.code.length == 0) revert InvalidInput();
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
    function _approve(address token, address spender, uint256 amount) private {
        _tokenCall(token, abi.encodeCall(IERC20Min.approve, (spender, 0)));
        if (amount != 0) _tokenCall(token, abi.encodeCall(IERC20Min.approve, (spender, amount)));
    }
    function _pull(address token, uint256 amount) private returns (uint256 beforeBalance) {
        beforeBalance = IERC20Min(token).balanceOf(address(this));
        _tokenCall(token, abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20Min(token).balanceOf(address(this)) - beforeBalance != amount) revert InvalidInput();
    }
    function _fee(address recipient, uint256 amount) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidInput();
        _send(recipient, amount);
        if (amount != 0) emit PlatformFee(msg.sender, recipient, amount, msg.sig);
    }
    function curveSwap(address token, bool buy, uint256 amount, uint256 minimum, address feeRecipient, uint256 feeEth, uint256 deadline) external payable lock(deadline) {
        if (amount == 0 || minimum == 0 || amount > type(uint128).max || feeEth > type(uint128).max) revert InvalidInput();
        IPonsFactory.Launch memory launch = IPonsFactory(ponsFactory).getLaunchedToken(token);
        if (!launch.exists || launch.token != token || launch.phase != 0) revert InvalidInput();
        IPonsCurve curve = IPonsCurve(launch.curve);
        if (curve.factory() != ponsFactory || curve.token() != token || curve.pairToken() != launch.pairToken) revert InvalidInput();
        address input = buy ? launch.pairToken : token;
        address output = buy ? token : launch.pairToken;
        if (msg.value != feeEth + (input == address(0) ? amount : 0)) revert InvalidInput();
        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 inputBefore;
        if (input != address(0)) { inputBefore = _pull(input, amount); _approve(input, launch.curve, amount); }
        uint256 outputBefore = output == address(0) ? msg.sender.balance : IERC20Min(output).balanceOf(msg.sender);
        if (buy) curve.buy{value: input == address(0) ? amount : 0}(amount, minimum, msg.sender);
        else curve.sell(amount, minimum, msg.sender);
        if (input != address(0)) _approve(input, launch.curve, 0);
        uint256 received = (output == address(0) ? msg.sender.balance : IERC20Min(output).balanceOf(msg.sender)) - outputBefore;
        // Strict minimum even when Pons clamps a graduation-crossing fill.
        if (received < minimum) revert InvalidInput();
        uint256 refund = input == address(0) ? address(this).balance - nativeBefore - feeEth : IERC20Min(input).balanceOf(address(this)) - inputBefore;
        if (refund > amount) revert InvalidInput();
        uint256 spent = amount - refund;
        if (input != address(0) && refund != 0) _tokenCall(input, abi.encodeCall(IERC20Min.transfer, (msg.sender, refund)));
        uint256 paidFee = feeEth * spent / amount;
        _fee(feeRecipient, paidFee);
        _send(msg.sender, address(this).balance - nativeBefore);
        emit CurveTraded(msg.sender, token, buy, spent, received);
    }
    /// @notice ETH -> quote -> token, or token -> quote -> ETH, atomically.
    /// Amount includes the platform fee on buys. Sells deduct it from ETH proceeds.
    /// Intermediate assets never require funding in the user's wallet.
    function tradeEth(EthTrade calldata p, Hop[] calldata route, uint256 deadline) external payable lock(deadline) {
        if (p.token == address(0) || p.token == weth || p.amount == 0 || p.amount > type(uint128).max || p.minimum == 0 || p.feePpm > 10000 || route.length > 4 || msg.value != (p.buy ? p.amount : 0)) revert InvalidInput();
        uint256 nativeBefore = address(this).balance - msg.value;
        address quote; IPonsCurve curve;
        if (p.curve) {
            IPonsFactory.Launch memory launch = IPonsFactory(ponsFactory).getLaunchedToken(p.token);
            if (!launch.exists || launch.token != p.token || launch.phase != 0) revert InvalidInput();
            curve = IPonsCurve(launch.curve); quote = launch.pairToken;
            if (curve.factory() != ponsFactory || curve.token() != p.token || curve.pairToken() != quote || quote == p.token) revert InvalidInput();
        } else quote = p.token;
        uint256 fee; uint256 output;
        if (p.buy) {
            fee = p.amount * p.feePpm / 1000000;
            uint256 funds = p.amount - fee;
            uint256 receivedBefore = IERC20Min(p.token).balanceOf(msg.sender);
            uint256 quoteAmount = _fromEth(route, quote, funds, deadline);
            if (p.curve) {
                uint256 beforeInput = _balance(quote);
                if (quote != address(0)) _approve(quote, address(curve), quoteAmount);
                curve.buy{value: quote == address(0) ? quoteAmount : 0}(quoteAmount, p.minimum, msg.sender);
                if (quote != address(0)) _approve(quote, address(curve), 0);
                // Reject incomplete inputs atomically rather than stranding a
                // stock balance or silently executing an unbounded refund swap.
                if (beforeInput - _balance(quote) != quoteAmount) revert InvalidInput();
            } else _tokenCall(p.token, abi.encodeCall(IERC20Min.transfer, (msg.sender, quoteAmount)));
            output = IERC20Min(p.token).balanceOf(msg.sender) - receivedBefore;
            if (output < p.minimum || address(this).balance != nativeBefore + fee) revert InvalidInput();
        } else {
            uint256 tokenBefore = _pull(p.token, p.amount);
            uint256 quoteAmount = p.amount;
            if (p.curve) {
                uint256 beforeOutput = _balance(quote);
                _approve(p.token, address(curve), p.amount);
                curve.sell(p.amount, 1, address(this));
                _approve(p.token, address(curve), 0);
                quoteAmount = _balance(quote) - beforeOutput;
            }
            uint256 gross = _toEth(route, quote, quoteAmount, deadline);
            if (IERC20Min(p.token).balanceOf(address(this)) != tokenBefore || address(this).balance != nativeBefore + gross) revert InvalidInput();
            fee = gross * p.feePpm / 1000000; output = gross - fee;
            if (output < p.minimum) revert InvalidInput();
        }
        _fee(p.feeRecipient, fee);
        if (!p.buy) _send(msg.sender, output);
        emit EthTraded(msg.sender, p.token, p.buy, p.amount, output, fee);
    }
    function _balance(address token) private view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20Min(token).balanceOf(address(this));
    }
    function _fromEth(Hop[] calldata route, address output, uint256 amount, uint256 deadline) private returns (uint256) {
        address input = route.length == 0 ? output : route[0].input;
        if (input == weth) IWeth(weth).deposit{value: amount}();
        else if (input != address(0)) revert InvalidInput();
        return _route(route, input, output, amount, deadline);
    }
    function _toEth(Hop[] calldata route, address input, uint256 amount, uint256 deadline) private returns (uint256) {
        address output = route.length == 0 ? input : route[route.length - 1].output;
        if (output != address(0) && output != weth) revert InvalidInput();
        uint256 received = _route(route, input, output, amount, deadline);
        if (output == weth) IWeth(weth).withdraw(received);
        return received;
    }
    function _route(Hop[] calldata route, address input, address output, uint256 amount, uint256 deadline) private returns (uint256) {
        if (amount == 0) revert InvalidInput();
        address currency = input;
        for (uint256 i; i < route.length; i++) {
            Hop calldata h = route[i];
            if (h.input != currency || h.input == h.output || h.minimum == 0) revert InvalidInput();
            amount = _hop(h, amount, deadline); currency = h.output;
        }
        if (currency != output) revert InvalidInput();
        return amount;
    }
    function _hop(Hop calldata h, uint256 amount, uint256 deadline) private returns (uint256 received) {
        if (amount > type(uint128).max || h.minimum > type(uint128).max || universalRouter.code.length == 0 || permit2.code.length == 0) revert InvalidInput();
        uint256 beforeInput = _balance(h.input); uint256 beforeOutput = _balance(h.output);
        if (h.input != address(0)) {
            _approve(h.input, permit2, amount);
            IPermit2(permit2).approve(h.input, universalRouter, uint160(amount), uint48(block.timestamp));
        }
        bytes memory command; bytes memory payload;
        if (h.version == 2 || h.version == 3) {
            if (h.input == address(0) || h.output == address(0)) revert InvalidInput();
            uint256[] memory prices = new uint256[](1);
            if (h.version == 2) {
                address[] memory path = new address[](2); path[0] = h.input; path[1] = h.output;
                command = hex"08"; payload = abi.encode(address(this), amount, h.minimum, path, true, prices);
            } else { command = hex"00"; payload = abi.encode(address(this), amount, h.minimum, abi.encodePacked(h.input, h.fee, h.output), true, prices); }
        } else if (h.version == 4) {
            bool zeroForOne = h.input < h.output;
            PoolKey memory key = PoolKey(zeroForOne ? h.input : h.output, zeroForOne ? h.output : h.input, h.fee, h.tickSpacing, h.hooks);
            bytes[] memory params = new bytes[](4);
            params[0] = abi.encode(V4Swap(key, zeroForOne, uint128(amount), uint128(h.minimum), 0, hex""));
            params[1] = abi.encode(h.input, amount, true);
            params[2] = abi.encode(h.output, address(this), uint256(0));
            params[3] = abi.encode(h.input, address(this), uint256(0));
            command = hex"10"; payload = abi.encode(hex"060b0e0e", params);
        } else revert InvalidInput();
        bytes[] memory inputs = new bytes[](2); inputs[0] = payload;
        inputs[1] = abi.encode(address(0), address(this), uint256(0));
        IUniversalRouter(universalRouter).execute{value: h.input == address(0) ? amount : 0}(bytes.concat(command, hex"04"), inputs, deadline);
        if (h.input != address(0)) {
            IPermit2(permit2).approve(h.input, universalRouter, 0, 0); _approve(h.input, permit2, 0);
        }
        if (beforeInput - _balance(h.input) != amount) revert InvalidInput();
        received = _balance(h.output) - beforeOutput;
        if (received < h.minimum) revert InvalidInput();
    }
    function withdrawV2(address pair, uint256 liquidity, uint256 minimum0, uint256 minimum1, address feeRecipient, uint256 feeEth, uint256 deadline) external payable lock(deadline) {
        if (liquidity == 0 || msg.value != feeEth) revert InvalidInput();
        address token0 = IV2Pair(pair).token0(); address token1 = IV2Pair(pair).token1();
        if (IV2Factory(IV2Router(v2Router).factory()).getPair(token0, token1) != pair) revert InvalidInput();
        _pull(pair, liquidity); _approve(pair, v2Router, liquidity);
        IV2Router(v2Router).removeLiquidity(token0, token1, liquidity, minimum0, minimum1, msg.sender, deadline);
        _approve(pair, v2Router, 0); _fee(feeRecipient, feeEth);
    }
    function withdrawV3(uint256 tokenId, uint128 liquidity, uint256 minimum0, uint256 minimum1, address feeRecipient, uint256 feeEth, uint256 deadline) external payable lock(deadline) {
        if (liquidity == 0 || msg.value != feeEth || IV3Positions(v3PositionManager).ownerOf(tokenId) != msg.sender) revert InvalidInput();
        IV3Positions(v3PositionManager).decreaseLiquidity(IV3Positions.Decrease(tokenId, liquidity, minimum0, minimum1, deadline));
        IV3Positions(v3PositionManager).collect(IV3Positions.Collect(tokenId, msg.sender, type(uint128).max, type(uint128).max));
        _fee(feeRecipient, feeEth);
    }
}
