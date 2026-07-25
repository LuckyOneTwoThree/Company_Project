# TimedExchange.sol（SKU 限时动态价渠道 · channelId=4 · 荷兰拍/线性定价 · P3）

## 合约宪法（严格按源码提取，防 AI 漂移）

| 项         | 值                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合约名       | TimedExchange                                                                                                                                                   |
| channelId | 4                                                                                                                                                               |
| 角色        | owner（构造写死）/ miner（onlyMiner）/ seller（挂单者）/ buyer（购买者）                                                                                                          |
| 定价模型      | `startPrice` 线性衰减到 `endPrice`（`priceAt(t)` 按时间比例插值）；`endPrice < startPrice` = 荷兰拍（降价）；`endPrice == startPrice` = 固定价                                            |
| 暂停        | `paused` bool；`setPaused(bool)` onlyMiner；用户写函数带 `whenNotPaused`；miner 函数不受影响；view 永远可用                                                                         |
| 渠道授权      | `setChannel(addr, enabled, validUntil)` onlyMiner；`isChannel(addr)` view                                                                                        |
| 手续费       | `feeBps`（万分比，默认 100=1%）；`setFeeBps(uint16)` onlyMiner；手续费转 `treasury`                                                                                           |
| 货款流向      | transferFrom(buyer→合约) 后立即转给卖家（扣手续费），原子完成                                                                                                                       |
| 锁定保护      | `list` 调 `ISkuRegistry.lockSku`；`buy/cancel` 调 `unlockSku`                                                                                                      |
| 到期失效      | `buy` 检查 `block.timestamp < order.deadline`；超时 revert `OrderExpired`                                                                                            |
| 错误全集      | `NotOwner` / `OrderNotFound` / `OrderExpired` / `OrderFilled` / `OrderCancelled` / `NotChannel` / `ContractPaused` / `ZeroAddress` / `InvalidFee` / `NotSeller` |
| 依赖        | ISkuRegistry · TradeLedger · IERC20                                                                                                                             |

---

## 一、完整 Solidity 源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────
// 依赖接口
// ─────────────────────────────────────────────
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ISkuRegistry {
    function skuOwner(bytes32 skuId) external view returns (address);
    function skuActive(bytes32 skuId) external view returns (bool);
    function channelTransfer(bytes32 skuId, address from, address to) external;
    function lockSku(bytes32 skuId) external;
    function unlockSku(bytes32 skuId) external;
}

interface ITradeLedger {
    function recordOrder(
        bytes32 skuId, address registry, uint8 channelId,
        address seller, address buyer, address payToken, uint256 price
    ) external;
}

// ─────────────────────────────────────────────
// TimedExchange
// ─────────────────────────────────────────────
contract TimedExchange {

    uint8 public constant CHANNEL_ID = 4;

    // ── 状态变量 ──────────────────────────────
    address public owner;
    address public treasury;
    ITradeLedger public tradeLedger;
    uint16  public feeBps = 100;    // 1%
    bool    public paused;

    struct ChannelGrant { bool enabled; uint64 validUntil; }
    mapping(address => ChannelGrant) public channelGrants;
    mapping(address => bool) public isMiner;

    // ── 订单结构 ──────────────────────────────
    struct Order {
        bytes32 skuId;
        address registry;
        address seller;
        address payToken;
        uint256 startPrice;   // 挂单时价格（最高价）
        uint256 endPrice;     // 截止时价格（最低价，可等于 startPrice=固定价）
        uint64  listedAt;     // 挂单时间戳
        uint64  deadline;     // 截止时间戳
        bool    filled;       // 已成交
        bool    cancelled;    // 已撤单
    }

    uint256 public orderCount;
    mapping(uint256 => Order) public orders;
    // skuId+registry => 当前活跃 orderId（0=无）
    mapping(bytes32 => mapping(address => uint256)) public activeOrder;

    // ── 事件 ──────────────────────────────────
    event Listed(
        uint256 indexed orderId,
        bytes32 indexed skuId,
        address indexed registry,
        address seller,
        address payToken,
        uint256 startPrice,
        uint256 endPrice,
        uint64  deadline
    );
    event Bought(
        uint256 indexed orderId,
        address indexed buyer,
        uint256 price,
        uint256 fee
    );
    event Cancelled(uint256 indexed orderId, address indexed seller);
    event MinerSet(address indexed addr, bool enabled);
    event ChannelSet(address indexed registry, bool enabled, uint64 validUntil);
    event FeeBpsSet(uint16 feeBps);
    event TradeLedgerSet(address tl);
    event Paused(bool isPaused);

    // ── 错误 ──────────────────────────────────
    error NotOwner();
    error NotMiner();
    error NotSeller();
    error NotChannel();
    error OrderNotFound();
    error OrderExpired();
    error OrderFilled();
    error OrderCancelled();
    error OrderAlreadyActive();
    error ContractPaused();
    error ZeroAddress();
    error InvalidFee();
    error InvalidPrice();   // endPrice > startPrice

    // ── 修饰符 ────────────────────────────────
    modifier onlyOwner()   { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyMiner()   { if (!isMiner[msg.sender] && msg.sender != owner) revert NotMiner(); _; }
    modifier whenNotPaused() { if (paused) revert ContractPaused(); _; }
    modifier validOrder(uint256 orderId) {
        if (orderId == 0 || orderId > orderCount) revert OrderNotFound();
        _;
    }

    // ── 构造 ──────────────────────────────────
    constructor(
        address _treasury,
        address _tradeLedger,
        address[] memory _miners
    ) {
        if (_treasury == address(0)) revert ZeroAddress();
        owner       = msg.sender;
        treasury    = _treasury;
        tradeLedger = ITradeLedger(_tradeLedger);
        for (uint256 i; i < _miners.length; ++i) {
            isMiner[_miners[i]] = true;
            emit MinerSet(_miners[i], true);
        }
    }

    // ═══════════════════════════════════════════
    // ⛏  Miner 运维区
    // ═══════════════════════════════════════════

    function setMiner(address addr, bool enabled) external onlyOwner {
        isMiner[addr] = enabled;
        emit MinerSet(addr, enabled);
    }

    function setPaused(bool _paused) external onlyMiner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setChannel(address registry, bool enabled, uint64 validUntil) external onlyMiner {
        channelGrants[registry] = ChannelGrant(enabled, validUntil);
        emit ChannelSet(registry, enabled, validUntil);
    }

    function setFeeBps(uint16 _feeBps) external onlyMiner {
        if (_feeBps > 2000) revert InvalidFee();
        feeBps = _feeBps;
        emit FeeBpsSet(_feeBps);
    }

    function setTradeLedger(address _tl) external onlyMiner {
        tradeLedger = ITradeLedger(_tl);
        emit TradeLedgerSet(_tl);
    }

    function setTreasury(address _t) external onlyOwner {
        if (_t == address(0)) revert ZeroAddress();
        treasury = _t;
    }

    /// @notice miner 强制撤单（紧急处理）
    function forceCancel(uint256 orderId) external onlyMiner validOrder(orderId) {
        _cancel(orderId);
    }

    // ═══════════════════════════════════════════
    // 👤 用户操作区
    // ═══════════════════════════════════════════

    /// @notice 卖家挂单
    /// @param skuId       SKU 标识
    /// @param registry    资产合约（ISkuRegistry）
    /// @param payToken    收款 TOKEN
    /// @param startPrice  挂单时价格（最高）
    /// @param endPrice    截止时价格（最低，<=startPrice；等于=固定价）
    /// @param duration    有效时长（秒）
    function list(
        bytes32 skuId,
        address registry,
        address payToken,
        uint256 startPrice,
        uint256 endPrice,
        uint64  duration
    ) external whenNotPaused returns (uint256 orderId) {
        if (!isChannel(registry)) revert NotChannel();
        if (endPrice > startPrice) revert InvalidPrice();
        if (ISkuRegistry(registry).skuOwner(skuId) != msg.sender) revert NotOwner();
        if (activeOrder[skuId][registry] != 0) revert OrderAlreadyActive();

        ISkuRegistry(registry).lockSku(skuId);

        orderId = ++orderCount;
        uint64 listedAt = uint64(block.timestamp);
        uint64 deadline = listedAt + duration;

        orders[orderId] = Order({
            skuId:      skuId,
            registry:   registry,
            seller:     msg.sender,
            payToken:   payToken,
            startPrice: startPrice,
            endPrice:   endPrice,
            listedAt:   listedAt,
            deadline:   deadline,
            filled:     false,
            cancelled:  false
        });
        activeOrder[skuId][registry] = orderId;

        emit Listed(orderId, skuId, registry, msg.sender, payToken, startPrice, endPrice, deadline);
    }

    /// @notice 购买（按当前时间对应价格成交）
    /// @param orderId  订单 ID
    function buy(uint256 orderId) external whenNotPaused validOrder(orderId) {
        Order storage o = orders[orderId];
        if (o.filled)    revert OrderFilled();
        if (o.cancelled) revert OrderCancelled();
        if (block.timestamp >= o.deadline) revert OrderExpired();

        uint256 price = priceAt(orderId, block.timestamp);
        uint256 fee   = price * feeBps / 10000;
        uint256 net   = price - fee;

        o.filled = true;
        activeOrder[o.skuId][o.registry] = 0;

        // 解锁 + 过户 SKU
        try ISkuRegistry(o.registry).unlockSku(o.skuId) {} catch {}
        try ISkuRegistry(o.registry).channelTransfer(o.skuId, o.seller, msg.sender) {} catch {}

        // 收款并分配
        IERC20(o.payToken).transferFrom(msg.sender, address(this), price);
        if (fee > 0) IERC20(o.payToken).transfer(treasury, fee);
        if (net > 0) IERC20(o.payToken).transfer(o.seller, net);

        // 写 TradeLedger（best-effort）
        if (address(tradeLedger) != address(0)) {
            try tradeLedger.recordOrder(
                o.skuId, o.registry, CHANNEL_ID,
                o.seller, msg.sender, o.payToken, price
            ) {} catch {}
        }

        emit Bought(orderId, msg.sender, price, fee);
    }

    /// @notice 卖家撤单（未成交时可撤）
    function cancel(uint256 orderId) external whenNotPaused validOrder(orderId) {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        _cancel(orderId);
    }

    // ═══════════════════════════════════════════
    // 📖 查询区（view，永远可用）
    // ═══════════════════════════════════════════

    function isChannel(address registry) public view returns (bool) {
        ChannelGrant memory g = channelGrants[registry];
        return g.enabled && (g.validUntil == 0 || block.timestamp <= g.validUntil);
    }

    /// @notice 当前时间对应价格（线性插值）
    /// @param orderId  订单 ID
    /// @param timestamp 查询时间戳
    function priceAt(uint256 orderId, uint256 timestamp) public view returns (uint256) {
        Order memory o = orders[orderId];
        if (timestamp >= o.deadline)  return o.endPrice;
        if (timestamp <= o.listedAt)  return o.startPrice;
        uint256 elapsed  = timestamp - o.listedAt;
        uint256 duration = o.deadline - o.listedAt;
        uint256 drop     = o.startPrice - o.endPrice;
        return o.startPrice - (drop * elapsed / duration);
    }

    function orderOf(bytes32 skuId, address registry) external view returns (uint256) {
        return activeOrder[skuId][registry];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    // ── 内部 ──────────────────────────────────
    function _cancel(uint256 orderId) internal {
        Order storage o = orders[orderId];
        if (o.filled || o.cancelled) revert OrderNotFound();
        o.cancelled = true;
        activeOrder[o.skuId][o.registry] = 0;
        try ISkuRegistry(o.registry).unlockSku(o.skuId) {} catch {}
        emit Cancelled(orderId, o.seller);
    }
}
```

---

## 二、完整 ABI（ethers 人类可读格式）

```
event Listed(uint256 indexed orderId, bytes32 indexed skuId, address indexed registry, address seller, address payToken, uint256 startPrice, uint256 endPrice, uint64 deadline)
event Bought(uint256 indexed orderId, address indexed buyer, uint256 price, uint256 fee)
event Cancelled(uint256 indexed orderId, address indexed seller)
event MinerSet(address indexed addr, bool enabled)
event ChannelSet(address indexed registry, bool enabled, uint64 validUntil)
event FeeBpsSet(uint16 feeBps)
event TradeLedgerSet(address tl)
event Paused(bool isPaused)

// 用户写函数
function list(bytes32 skuId, address registry, address payToken, uint256 startPrice, uint256 endPrice, uint64 duration) external returns (uint256 orderId)
function buy(uint256 orderId) external
function cancel(uint256 orderId) external

// Miner 函数
function setMiner(address addr, bool enabled) external
function setPaused(bool paused) external
function setChannel(address registry, bool enabled, uint64 validUntil) external
function setFeeBps(uint16 feeBps) external
function setTradeLedger(address tl) external
function setTreasury(address treasury) external
function forceCancel(uint256 orderId) external

// view
function isChannel(address registry) external view returns (bool)
function priceAt(uint256 orderId, uint256 timestamp) external view returns (uint256)
function orderOf(bytes32 skuId, address registry) external view returns (uint256)
function getOrder(uint256 orderId) external view returns (tuple(bytes32 skuId, address registry, address seller, address payToken, uint256 startPrice, uint256 endPrice, uint64 listedAt, uint64 deadline, bool filled, bool cancelled))
function orderCount() external view returns (uint256)
function feeBps() external view returns (uint16)
function paused() external view returns (bool)
function isMiner(address) external view returns (bool)
function treasury() external view returns (address)
function tradeLedger() external view returns (address)
function channelGrants(address) external view returns (bool enabled, uint64 validUntil)
```

---

## 三、函数参数使用说明

| 函数            | 谁可调          | 参数说明                                                                                                                                |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list`        | 任何人（SKU 持有者） | `skuId`=SKU 标识；`registry`=资产合约；`payToken`=收款 TOKEN；`startPrice`=挂单价（最高）；`endPrice`=截止价（最低，≤startPrice）；`duration`=秒数（建议 3600~86400） |
| `buy`         | 任何人          | `orderId`=订单 ID；以 `priceAt(orderId, now)` 为成交价；调用前需 approve 足够额度（建议 approve startPrice 兜底）                                          |
| `cancel`      | 卖家           | 任何时候未成交均可撤（含已超期）；超期未撤则 SKU 仍被锁定，需 cancel 解锁                                                                                         |
| `forceCancel` | miner        | 紧急解锁，可处理卖家不主动撤单场景                                                                                                                   |
| `priceAt`     | 任何人（view）    | 荷兰拍场景：随时间线性降价；`endPrice==startPrice`=固定价不变                                                                                          |

---

## 四、部署 SH（[timed-exchange-deploy.sh](http://timed-exchange-deploy.sh)）

```bash
#!/usr/bin/env bash
# timed-exchange-deploy.sh — TimedExchange 部署脚本
# 用法: bash timed-exchange-deploy.sh obt|r9|qdt
set -euo pipefail

CHAIN="${1:-}"
[[ -z "${CHAIN}" ]] && { echo "Usage: $0 obt|r9|qdt"; exit 1; }

TREASURY="0xaf5cd2c046a0f945290171eb80d31136dc76b66d"
MINER_1="${MINER_1:-}"
PRIVATE_KEY="${PRIVATE_KEY:-}"

case "${CHAIN}" in
  obt) EXPECT_ID=1008611;   RPC="<http://47.86.44.43:39546>"; TRADE_LEDGER="${TRADE_LEDGER_OBT:-0x0000000000000000000000000000000000000000}" ;;
  r9)  EXPECT_ID=555555555;  RPC="<http://47.86.44.43:41546>"; TRADE_LEDGER="${TRADE_LEDGER_R9:-0x0000000000000000000000000000000000000000}" ;;
  qdt) EXPECT_ID=88888888;   RPC="<http://47.86.44.43:40546>"; TRADE_LEDGER="${TRADE_LEDGER_QDT:-0x0000000000000000000000000000000000000000}" ;;
  *) echo "Unknown chain: ${CHAIN}"; exit 1 ;;
esac

[[ -z "${PRIVATE_KEY}" ]] && { echo "PRIVATE_KEY not set"; exit 1; }
[[ -z "${MINER_1}" ]]     && { echo "MINER_1 not set"; exit 1; }

GOT_ID=$(cast chain-id --rpc-url "${RPC}" 2>/dev/null || echo 0)
[[ "${GOT_ID}" != "${EXPECT_ID}" ]] && { echo "Chain ID mismatch: got ${GOT_ID} want ${EXPECT_ID}"; exit 1; }

grep -q 'optimizer = true' foundry.toml || { echo "foundry.toml: optimizer=true missing"; exit 1; }
grep -q 'via_ir = true'    foundry.toml || { echo "foundry.toml: via_ir=true missing"; exit 1; }

echo "[${CHAIN}] Deploying TimedExchange..."
forge build --skip test --skip script > build.log 2>&1 || { tail -n 30 build.log; exit 1; }

DEPLOY_OUT=$(forge create src/TimedExchange.sol:TimedExchange \
  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" \
  --evm-version paris --skip test --skip script \
  --constructor-args "${TREASURY}" "${TRADE_LEDGER}" "[${MINER_1}]" 2>&1)

echo "${DEPLOY_OUT}" >> deploy-${CHAIN}.log
CONTRACT=$(echo "${DEPLOY_OUT}" | grep 'Deployed to:' | awk '{print $NF}')
[[ -z "${CONTRACT}" ]] && { tail -n 30 deploy-${CHAIN}.log; exit 1; }

cast call "${CONTRACT}" "feeBps()" --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1
cast call "${CONTRACT}" "paused()" --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1

echo "[${CHAIN}] TimedExchange: ${CONTRACT}"
echo "→ ShortNumRegistry.setChannel(${CONTRACT}, true, 0)"
echo "→ GoodsMarket.setChannel(${CONTRACT}, true, 0)"
echo "→ TradeLedger.setChannel(${CONTRACT}, true)"
```

---

## 五、完整部署参数

| 参数          | OBT (1008611)                                | R9 (555555555)                               |
| ----------- | -------------------------------------------- | -------------------------------------------- |
| treasury    | `0xaf5cd2c046a0f945290171eb80d31136dc76b66d` | `0xaf5cd2c046a0f945290171eb80d31136dc76b66d` |
| tradeLedger | ⬜ 待 P1-C 地址回填                                | ⬜ 待 P1-C 地址回填                                |
| miners      | ⬜ 填入运营 miner 钱包                              | ⬜ 填入运营 miner 钱包                              |
| evm_version | paris                                        | paris                                        |
| feeBps（默认）  | 100（1%）                                      | 100（1%）                                      |

---

## 六、部署登记表
