// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import "RobinhoodExecutor.sol";
// Local protocol harness, not mainnet bytecode. Rates and liquidity are fixtures.
contract EthCoin {
    uint8 public immutable decimals;
    string public symbol = "STOCK";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(uint8 d) { decimals = d; }
    function mint(address a, uint256 n) external { balanceOf[a] += n; emit Transfer(address(0), a, n); }
    function approve(address a, uint256 n) external returns (bool) { allowance[msg.sender][a] = n; return true; }
    function transfer(address a, uint256 n) external returns (bool) { _move(msg.sender, a, n); return true; }
    function transferFrom(address a, address b, uint256 n) external returns (bool) { allowance[a][msg.sender] -= n; _move(a, b, n); return true; }
    function _move(address a, address b, uint256 n) internal { balanceOf[a] -= n; balanceOf[b] += n; emit Transfer(a, b, n); }
}
contract EthWeth is EthCoin {
    constructor() EthCoin(18) {}
    function deposit() external payable { balanceOf[msg.sender] += msg.value; emit Transfer(address(0), msg.sender, msg.value); }
    function withdraw(uint256 n) external { balanceOf[msg.sender] -= n; emit Transfer(msg.sender, address(0), n); (bool ok,) = msg.sender.call{value: n}(""); require(ok); }
    receive() external payable {}
}
contract EthPermit {
    struct Permission { uint160 amount; uint48 expiration; }
    mapping(address => mapping(address => mapping(address => Permission))) public allowance;
    function approve(address token, address spender, uint160 amount, uint48 expiration) external { allowance[msg.sender][token][spender] = Permission(amount, expiration); }
    function transferFrom(address from, address to, uint160 amount, address token) external {
        Permission storage p = allowance[from][token][msg.sender]; require(p.expiration >= block.timestamp); p.amount -= amount;
        require(EthCoin(token).transferFrom(from, to, amount));
    }
}
contract EthRouter {
    struct Rate { uint256 numerator; uint256 denominator; uint256 spendBps; bool failing; }
    mapping(address => mapping(address => Rate)) public rates;
    receive() external payable {}
    function configure(address input, address output, uint256 n, uint256 d, uint256 spendBps, bool failing) external { rates[input][output] = Rate(n, d, spendBps, failing); }
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(deadline >= block.timestamp && commands.length == 2 && commands[1] == 0x04 && inputs.length == 2);
        address recipient; address input; address output; uint256 amount; uint256 minimum; bool payer;
        if (commands[0] == 0x08) {
            address[] memory path; uint256[] memory prices;
            (recipient, amount, minimum, path, payer, prices) = abi.decode(inputs[0], (address,uint256,uint256,address[],bool,uint256[]));
            require(path.length == 2 && prices.length == 1 && prices[0] == 0); input = path[0]; output = path[1];
        } else if (commands[0] == 0x00) {
            bytes memory path; uint256[] memory prices;
            (recipient, amount, minimum, path, payer, prices) = abi.decode(inputs[0], (address,uint256,uint256,bytes,bool,uint256[]));
            require(path.length == 43 && prices.length == 1 && prices[0] == 0);
            assembly { input := shr(96, mload(add(path, 32))) output := shr(96, mload(add(path, 55))) }
        } else {
            require(commands[0] == 0x10);
            (bytes memory actions, bytes[] memory p) = abi.decode(inputs[0], (bytes,bytes[])); require(keccak256(actions) == keccak256(hex"060b0e0e") && p.length == 4);
            RobinhoodExecutor.V4Swap memory s = abi.decode(p[0], (RobinhoodExecutor.V4Swap));
            input = s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1; output = s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0;
            amount = s.amountIn; minimum = s.amountOutMinimum; require(s.minHopPriceX36 == 0 && s.hookData.length == 0);
            (address currency,uint256 settle,bool user) = abi.decode(p[1], (address,uint256,bool)); require(currency == input && settle == amount); payer = user;
            (currency,recipient,settle) = abi.decode(p[2], (address,address,uint256)); require(currency == output && settle == 0);
            address refundTo; uint256 refundAmount;
            (currency,refundTo,refundAmount) = _refund(p[3]); require(currency == input && refundTo == msg.sender && refundAmount == 0);
        }
        require(payer && recipient == msg.sender);
        Rate memory r = rates[input][output]; require(!r.failing && r.denominator > 0);
        uint256 spent = amount * r.spendBps / 10000; uint256 received = spent * r.numerator / r.denominator; require(received >= minimum);
        if (input == address(0)) { require(msg.value == amount); if (amount > spent) _send(msg.sender, amount - spent); }
        else { require(msg.value == 0); EthPermit(0x000000000022D473030F116dDEE9F6B43aC78BA3).transferFrom(msg.sender, address(this), uint160(spent), input); }
        if (output == address(0)) _send(recipient, received); else EthCoin(output).mint(recipient, received);
        (address swept,address to,uint256 min) = abi.decode(inputs[1], (address,address,uint256)); require(swept == address(0) && to == msg.sender && min == 0);
    }
    function _refund(bytes memory data) private pure returns(address,address,uint256) { return abi.decode(data,(address,address,uint256)); }
    function _send(address to, uint256 n) private { (bool ok,) = to.call{value:n}(""); require(ok); }
}
contract EthFactory is IPonsFactory {
    mapping(address => Launch) private launches;
    function set(address token,address curve,address quote,uint8 phase) external { launches[token] = Launch(token,curve,msg.sender,msg.sender,quote,0,3000,60,0,false,phase,0,0,0,true); }
    function getLaunchedToken(address token) external view returns(Launch memory) { return launches[token]; }
}
contract EthCurve {
    address public immutable factory; address public immutable token; address public immutable pairToken;
    uint256 public immutable scale; bool public failing; bool public partialFill;
    constructor(address f,address t,address q,uint256 s) { factory=f; token=t; pairToken=q; scale=s; }
    receive() external payable {}
    function configure(bool f,bool p) external { failing=f; partialFill=p; }
    function buy(uint256 n,uint256 minimum,address to) external payable returns(uint256 out) {
        require(!failing); if(pairToken==address(0)) require(msg.value==n); else { require(msg.value==0); EthCoin(pairToken).transferFrom(msg.sender,address(this),n); }
        uint256 spent=partialFill?n/2:n; out=spent*scale; require(out>=minimum); EthCoin(token).mint(to,out);
        if(spent<n) { if(pairToken==address(0)) { (bool ok,)=msg.sender.call{value:n-spent}(""); require(ok); } else EthCoin(pairToken).transfer(msg.sender,n-spent); }
    }
    function sell(uint256 n,uint256 minimum,address to) external returns(uint256 out) {
        require(!failing); EthCoin(token).transferFrom(msg.sender,address(this),n); out=n/scale; require(out>=minimum);
        if(pairToken==address(0)) { (bool ok,)=to.call{value:out}(""); require(ok); } else EthCoin(pairToken).transfer(to,out);
    }
}
