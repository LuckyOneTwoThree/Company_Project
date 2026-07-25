# TradeLedger.sol（统一订单台账 · SKU 全渠道成交记录）

<aside>  
📜

**合约宪法 · TradeLedger（P1 · 2026-07-21）**

1. **定位**：所有 SKU 获得渠道（含一级购买 channelId=0）均写 TradeOrder；解决「短号买卖无订单记录」。
2. **权限**：只有 `isChannel[msg.sender]=true` 的合约才能写单（`onlyChannel`）；miner 管渠道授权（`setChannel`）。
3. **奖励铁律**：本合约不调任何奖励钩子，不持任何资金，只记录。
4. **部署顺序**：TradeLedger 最先部署；其他渠道合约构造时传入 tradeLedger 地址。
5. **channelId 定义**：0=PRIMARY（一级购买）/ 1=Gift / 2=FixedPrice / 3=Auction / 5=Rental / 6=Mining / 7=Fractional。  
   
   </aside>

统一链上订单台账——不管是短号一级购买、有偿赠送、一口价转卖、拍卖、租赁，全部成交在此合约记一条 `TradeOrder`，链下通过 `OrderRecorded` 事件派生索引。

## 一、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TradeLedger — 统一 SKU 交易订单台账
/// @notice P1 · 2026-07-21
/// @notice channelId: 0=PRIMARY(一级购买) 1=Gift 2=FixedPrice 3=Auction 5=Rental 6=Mining 7=Fractional
contract TradeLedger {

    struct TradeOrder {
        bytes32 skuId;       // keccak256(number) for ShortNumRegistry, codeId for GoodsMarket
        address registry;    // 资产合约地址
        uint8   channelId;   // 0=PRIMARY, 1=Gift, 2=FixedPrice, 3=Auction, 5=Rental...
        address seller;      // 一级购买时 = address(0)
        address buyer;
        address payToken;    // address(0) = 无支付（系统赠送）
        uint256 price;       // 实付金额（0 = 免费）
        uint64  time;        // block.timestamp
        bool    reversed;    // 是否已有对应冲销单
        bytes32 linkedId;    // 冲销单 → 指向原订单 orderId
    }

    mapping(bytes32 => TradeOrder) public tradeOrders;
    mapping(bytes32 => bytes32[]) private _ordersBySku;   // skuId => orderId[]
    mapping(address => bytes32[]) private _ordersByUser;  // buyer/seller => orderId[]
    uint256 public orderNonce;

    mapping(address => bool) public isChannel;
    mapping(address => bool) public isMiner;
    address[] private _miners;
    uint8 public constant MAX_MINERS = 3;
    bool public paused;

    // Events
    event OrderRecorded(bytes32 indexed orderId, bytes32 indexed skuId, address indexed registry,
        uint8 channelId, address seller, address buyer, address payToken, uint256 price, uint64 time);
    event OrderReversed(bytes32 indexed reversalId, bytes32 indexed originalId);
    event ChannelSet(address indexed channel, bool enabled);
    event MinerAdded(address indexed miner);
    event MinerRemoved(address indexed miner);
    event Paused(bool paused);

    // Errors
    error NotMiner(); error NotChannel(); error MinerExists(); error MinerNotFound();
    error TooManyMiners(); error CannotRemoveLastMiner(); error ZeroAddr();
    error Paused_(); error OrderNotFound(); error AlreadyReversed();

    constructor(address[] memory miners_) {
        require(miners_.length > 0 && miners_.length <= MAX_MINERS, "TL: miners 1..3");
        for (uint256 i; i < miners_.length; ++i) {
            if (miners_[i] != address(0) && !isMiner[miners_[i]]) {
                isMiner[miners_[i]] = true;
                _miners.push(miners_[i]);
            }
        }
    }

    modifier onlyMiner()   { if (!isMiner[msg.sender])   revert NotMiner();   _; }
    modifier onlyChannel() { if (!isChannel[msg.sender]) revert NotChannel(); _; }
    modifier whenNotPaused() { if (paused) revert Paused_(); _; }

    /// @notice 记录一笔成交订单。仅授权渠道合约可调。
    function recordOrder(
        bytes32 skuId,
        address registry,
        uint8   channelId,
        address seller,
        address buyer,
        address payToken,
        uint256 price_
    ) external onlyChannel whenNotPaused returns (bytes32 orderId) {
        orderNonce++;
        orderId = keccak256(abi.encode(block.chainid, channelId, skuId, orderNonce));
        tradeOrders[orderId] = TradeOrder({
            skuId:     skuId,
            registry:  registry,
            channelId: channelId,
            seller:    seller,
            buyer:     buyer,
            payToken:  payToken,
            price:     price_,
            time:      uint64(block.timestamp),
            reversed:  false,
            linkedId:  bytes32(0)
        });
        _ordersBySku[skuId].push(orderId);
        if (buyer  != address(0)) _ordersByUser[buyer].push(orderId);
        if (seller != address(0) && seller != buyer) _ordersByUser[seller].push(orderId);
        emit OrderRecorded(orderId, skuId, registry, channelId, seller, buyer, payToken, price_, uint64(block.timestamp));
    }

    /// @notice 记录冲销单（退款/撤销）；原订单标记 reversed=true
    function recordReversal(bytes32 originalId)
        external onlyChannel whenNotPaused returns (bytes32 reversalId)
    {
        TradeOrder storage orig = tradeOrders[originalId];
        if (orig.time == 0) revert OrderNotFound();
        if (orig.reversed) revert AlreadyReversed();
        orig.reversed = true;
        orderNonce++;
        reversalId = keccak256(abi.encode(block.chainid, orig.channelId, orig.skuId, orderNonce, bytes1(0xFF)));
        tradeOrders[reversalId] = TradeOrder({
            skuId:     orig.skuId,
            registry:  orig.registry,
            channelId: orig.channelId,
            seller:    orig.buyer,    // 冲销：买家→卖家方向反转
            buyer:     orig.seller,
            payToken:  orig.payToken,
            price:     orig.price,
            time:      uint64(block.timestamp),
            reversed:  true,
            linkedId:  originalId
        });
        emit OrderReversed(reversalId, originalId);
    }

    // ---------- 查询 ----------
    function ordersOfSku(bytes32 skuId, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory ids, uint256 total)
    {
        bytes32[] storage all = _ordersBySku[skuId];
        total = all.length;
        uint256 end = offset + limit > total ? total : offset + limit;
        ids = new bytes32[](end > offset ? end - offset : 0);
        for (uint256 i = offset; i < end; ++i) ids[i - offset] = all[i];
    }

    function ordersOfUser(address user, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory ids, uint256 total)
    {
        bytes32[] storage all = _ordersByUser[user];
        total = all.length;
        uint256 end = offset + limit > total ? total : offset + limit;
        ids = new bytes32[](end > offset ? end - offset : 0);
        for (uint256 i = offset; i < end; ++i) ids[i - offset] = all[i];
    }

    function getOrder(bytes32 orderId) external view returns (TradeOrder memory) {
        return tradeOrders[orderId];
    }

    function skuOrderCount(bytes32 skuId) external view returns (uint256) { return _ordersBySku[skuId].length; }
    function userOrderCount(address user) external view returns (uint256) { return _ordersByUser[user].length; }

    // ---------- miner 管理 ----------
    function setChannel(address channel, bool enabled) external onlyMiner {
        if (channel == address(0)) revert ZeroAddr();
        isChannel[channel] = enabled;
        emit ChannelSet(channel, enabled);
    }
    function setPaused(bool v) external onlyMiner { paused = v; emit Paused(v); }
    function addMiner(address m) external onlyMiner {
        if (m == address(0)) revert ZeroAddr();
        if (isMiner[m]) revert MinerExists();
        if (_miners.length >= MAX_MINERS) revert TooManyMiners();
        isMiner[m] = true; _miners.push(m);
        emit MinerAdded(m);
    }
    function removeMiner(address m) external onlyMiner {
        if (!isMiner[m]) revert MinerNotFound();
        if (_miners.length <= 1) revert CannotRemoveLastMiner();
        isMiner[m] = false;
        for (uint256 i; i < _miners.length; ++i) {
            if (_miners[i] == m) { _miners[i] = _miners[_miners.length-1]; _miners.pop(); break; }
        }
        emit MinerRemoved(m);
    }
    function getMiners() external view returns (address[] memory) { return _miners; }
}
```

## 二、ABI（human-readable）

```jsx
// 写入（onlyChannel）
'function recordOrder(bytes32 skuId, address registry, uint8 channelId, address seller, address buyer, address payToken, uint256 price_) returns (bytes32 orderId)',
'function recordReversal(bytes32 originalId) returns (bytes32 reversalId)',
// 查询
'function getOrder(bytes32 orderId) view returns (tuple(bytes32 skuId, address registry, uint8 channelId, address seller, address buyer, address payToken, uint256 price, uint64 time, bool reversed, bytes32 linkedId))',
'function ordersOfSku(bytes32 skuId, uint256 offset, uint256 limit) view returns (bytes32[] ids, uint256 total)',
'function ordersOfUser(address user, uint256 offset, uint256 limit) view returns (bytes32[] ids, uint256 total)',
'function skuOrderCount(bytes32 skuId) view returns (uint256)',
'function userOrderCount(address user) view returns (uint256)',
'function isChannel(address) view returns (bool)',
'function isMiner(address) view returns (bool)',
'function paused() view returns (bool)',
// miner
'function setChannel(address channel, bool enabled)',
'function setPaused(bool)',
'function addMiner(address)',
'function removeMiner(address)',
'function getMiners() view returns (address[])',
// events
'event OrderRecorded(bytes32 indexed orderId, bytes32 indexed skuId, address indexed registry, uint8 channelId, address seller, address buyer, address payToken, uint256 price, uint64 time)',
'event OrderReversed(bytes32 indexed reversalId, bytes32 indexed originalId)',
'event ChannelSet(address indexed channel, bool enabled)',
```

## 三、部署脚本（[trade-ledger-deploy.sh](http://trade-ledger-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail
# 用法：export PK=0x私钥 && bash trade-ledger-deploy.sh <r9|obt|qdt>
CHAIN="${1:?用法: bash trade-ledger-deploy.sh <r9|obt|qdt>}"
case "$CHAIN" in
  r9)  EXPECT_ID=555555555;  RPC="${RPC:-<http://47.86.44.43:41546>}" ;;
  obt) EXPECT_ID=1008611;    RPC="${RPC:-<http://47.86.44.43:39546>}" ;;
  qdt) EXPECT_ID=88888888;   RPC="${RPC:-<http://47.86.44.43:40546>}" ;;
  *) echo "unknown chain"; exit 1 ;;
esac
PK="${PK:?请先 export PK=0x私钥}"
DEPLOYER="$(cast wallet address --private-key "$PK")"
ACTUAL="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL" = "$EXPECT_ID" ] || { echo "❌ chainId 不符 $ACTUAL ≠ $EXPECT_ID"; exit 1; }
LOG="tl-deploy.${CHAIN}.$(date +%s).log"
forge build --skip test --skip script >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
forge create src/TradeLedger.sol:TradeLedger \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --evm-version shanghai \
  --skip test --skip script \
  --constructor-args "[${DEPLOYER}]" >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
ADDR="$(grep 'Deployed to:' "$LOG" | tail -1 | sed 's/Deployed to: //')"
[ -n "$ADDR" ] || { echo "❌ 未取到地址"; exit 1; }
# 自检
[ "$(cast call "$ADDR" 'paused()(bool)' --rpc-url "$RPC")" = "false" ] || echo "⚠️ paused ≠ false"
echo "TradeLedger_${CHAIN}=${ADDR}"
echo "$(date +%F_%T),$CHAIN,$EXPECT_ID,TradeLedger,$ADDR" >> tl-deploy.log
```

## 四、部署参数 & 授权清单

| 项                                        | 值                         |
| ---------------------------------------- | ------------------------- |
| 构造 `miners_`                             | `[部署者地址]`                 |
| 部署后：`setChannel(GiftChannel, true)`      | GiftChannel 上线后立即授权       |
| 部署后：`setChannel(FixedPriceMarket, true)` | FixedPriceMarket 上线后      |
| 部署后：`setChannel(RentalChannel, true)`    | RentalChannel 上线后         |
| 部署后：`setChannel(ShortNumRegistry, true)` | PRIMARY 单（channelId=0）写入权 |
| 部署后：`setChannel(GoodsMarket, true)`      | GoodsMarket PRIMARY 单写入权  |

## 五、部署登记表
