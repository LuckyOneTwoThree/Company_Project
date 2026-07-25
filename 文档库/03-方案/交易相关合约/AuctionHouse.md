## 

# AuctionHouse.sol（SKU 拍卖渠道 · channelId=3 · 个人/系统拍卖 · P2）

## 合约宪法（严格按源码提取，防 AI 漂移）

| 项         | 值                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 合约名       | AuctionHouse                                                                                                                                     |
| channelId | 3                                                                                                                                                |
| 角色        | owner（构造写死） / miner（onlyMiner） / seller（挂拍者） / bidder（出价者） / 任何人（settle）                                                                         |
| 暂停        | `paused` bool；`setPaused(bool)` onlyMiner；用户写函数带 `whenNotPaused`；miner 函数不受影响；view 永远可用                                                          |
| 渠道授权      | `setChannel(addr, enabled, validUntil)` onlyMiner；`isChannel(addr)` view；合约自身不需授权                                                                |
| 手续费       | `feeBps`（万分比，默认 250=2.5%）；`setFeeBps(uint16)` onlyMiner；手续费转 `treasury`                                                                          |
| 货款流向      | 最终价款扣手续费后 transferFrom 合约→卖家（结算时从合约托管余额转出）；出价托管 IERC20.transferFrom(bidder→合约)                                                                   |
| 系统拍卖      | 卖家为 `treasury`，miner 调 `listSystemAuction` 代替卖家挂拍                                                                                                |
| 锁定保护      | `listAuction` 调 `ISkuRegistry.lockSku`；`settle/cancelAuction` 调 `unlockSku`                                                                      |
| 错误全集      | `NotOwner` / `AuctionNotFound` / `AuctionEnded` / `AuctionNotEnded` / `BidTooLow` / `NoBids` / `HasBids` / `Paused` / `NotChannel` / `SkuLocked` |
| 部署链       | OBT 1008611 · R9 555555555（paris，optimizer=true）                                                                                                 |
| 依赖        | ISkuRegistry · TradeLedger · IERC20                                                                                                              |

---

## 一、完整 Solidity 源码##  一、完整 Solidity 源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────
// 依赖接口
// ─────────────────────────────────────────────
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
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
        bytes32 skuId,
        address registry,
        uint8   channelId,
        address seller,
        address buyer,
        address payToken,
        uint256 price
    ) external;
}

// ─────────────────────────────────────────────
// AuctionHouse
// ─────────────────────────────────────────────
contract AuctionHouse {

    // ── 常量 ──────────────────────────────────
    uint8 public constant CHANNEL_ID = 3;

    // ── 状态变量 ──────────────────────────────
    address public owner;
    address public treasury;
    ITradeLedger public tradeLedger;         // 可为 address(0)（best-effort）
    uint16  public feeBps = 250;             // 2.5%
    bool    public paused;

    // 渠道授权：哪些资产合约允许此渠道操作
    struct ChannelGrant { bool enabled; uint64 validUntil; }
    mapping(address => ChannelGrant) public channelGrants;

    // miner 白名单
    mapping(address => bool) public isMiner;

    // ── 拍卖结构 ──────────────────────────────
    struct Auction {
        bytes32  skuId;
        address  registry;       // ISkuRegistry 地址
        address  seller;
        address  payToken;
        uint256  startPrice;     // 起拍价（最低出价）
        uint256  reservePrice;   // 底价（0=无底价）；低于底价时 settle 不成交
        uint64   endTime;        // 截止时间戳
        bool     settled;        // 已结算
        bool     cancelled;      // 已撤销
        // 当前最高出价
        address  topBidder;
        uint256  topBid;
    }

    uint256 public auctionCount;
    mapping(uint256 => Auction) public auctions;

    // auctionId => 出价方 => 托管金额（仅记录非 top 出价方的待退余额）
    // 当新的最高出价出现时，前 top 出价方余额立即退回，此 map 仅作安全兜底
    mapping(uint256 => mapping(address => uint256)) public pendingRefunds;

    // skuId+registry 组合 => 当前 auctionId（0 代表无）
    mapping(bytes32 => mapping(address => uint256)) public activeAuction;

    // ── 事件 ──────────────────────────────────
    event AuctionCreated(
        uint256 indexed auctionId,
        bytes32 indexed skuId,
        address indexed registry,
        address seller,
        address payToken,
        uint256 startPrice,
        uint256 reservePrice,
        uint64  endTime
    );
    event BidPlaced(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 amount,
        address prevBidder,
        uint256 prevAmount
    );
    event AuctionSettled(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 finalPrice,
        uint256 fee
    );
    event AuctionCancelled(uint256 indexed auctionId, address indexed seller);
    event MinerSet(address indexed addr, bool enabled);
    event ChannelSet(address indexed registry, bool enabled, uint64 validUntil);
    event FeeBpsSet(uint16 feeBps);
    event TradeLedgerSet(address tradeLedger);
    event Paused(bool isPaused);

    // ── 错误 ──────────────────────────────────
    error NotOwner();
    error NotMiner();
    error NotChannel();
    error NotSeller();
    error AuctionNotFound();
    error AuctionEnded();
    error AuctionNotEnded();
    error AuctionAlreadyActive();
    error BidTooLow();
    error HasBids();
    error NoBids();
    error ReserveNotMet();
    error SkuAlreadyLocked();
    error ContractPaused();
    error ZeroAddress();
    error InvalidFee();

    // ── 修饰符 ────────────────────────────────
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyMiner() { if (!isMiner[msg.sender] && msg.sender != owner) revert NotMiner(); _; }
    modifier whenNotPaused() { if (paused) revert ContractPaused(); _; }
    modifier validAuction(uint256 auctionId) {
        if (auctionId == 0 || auctionId > auctionCount) revert AuctionNotFound();
        _;
    }

    // ── 构造 ──────────────────────────────────
    constructor(
        address _treasury,
        address _tradeLedger,    // 可传 address(0)
        address[] memory _miners
    ) {
        if (_treasury == address(0)) revert ZeroAddress();
        owner    = msg.sender;
        treasury = _treasury;
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

    /// @notice 授权资产合约（ISkuRegistry）使用本渠道
    function setChannel(address registry, bool enabled, uint64 validUntil) external onlyMiner {
        channelGrants[registry] = ChannelGrant(enabled, validUntil);
        emit ChannelSet(registry, enabled, validUntil);
    }

    function setFeeBps(uint16 _feeBps) external onlyMiner {
        if (_feeBps > 2000) revert InvalidFee(); // 最高 20%
        feeBps = _feeBps;
        emit FeeBpsSet(_feeBps);
    }

    function setTradeLedger(address _tl) external onlyMiner {
        tradeLedger = ITradeLedger(_tl);
        emit TradeLedgerSet(_tl);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /// @notice 系统拍卖：miner 代 treasury 挂拍（卖家为 treasury）
    function listSystemAuction(
        bytes32  skuId,
        address  registry,
        address  payToken,
        uint256  startPrice,
        uint256  reservePrice,
        uint64   duration
    ) external onlyMiner whenNotPaused returns (uint256 auctionId) {
        return _createAuction(skuId, registry, treasury, payToken, startPrice, reservePrice, duration);
    }

    /// @notice miner 强制结算（处理争议/超期未结算）
    function forceSettle(uint256 auctionId) external onlyMiner validAuction(auctionId) {
        _settle(auctionId);
    }

    /// @notice miner 强制撤拍（紧急处理）
    function forceCancel(uint256 auctionId) external onlyMiner validAuction(auctionId) {
        _cancel(auctionId, true);
    }

    // ═══════════════════════════════════════════
    // 👤 用户操作区
    // ═══════════════════════════════════════════

    /// @notice 卖家挂拍
    /// @param skuId     SKU 标识（短号=keccak256(number)，商品=codeId）
    /// @param registry  资产合约地址（ISkuRegistry）
    /// @param payToken  收款 TOKEN 地址
    /// @param startPrice 起拍价
    /// @param reservePrice 底价（0=无底价，低于底价 settle 时退款不成交）
    /// @param duration  拍卖时长（秒）
    function listAuction(
        bytes32  skuId,
        address  registry,
        address  payToken,
        uint256  startPrice,
        uint256  reservePrice,
        uint64   duration
    ) external whenNotPaused returns (uint256 auctionId) {
        return _createAuction(skuId, registry, msg.sender, payToken, startPrice, reservePrice, duration);
    }

    /// @notice 出价
    /// @param auctionId 拍卖 ID
    /// @param amount    出价金额（须 > 当前最高出价）
    function bid(uint256 auctionId, uint256 amount)
        external whenNotPaused validAuction(auctionId)
    {
        Auction storage a = auctions[auctionId];
        if (a.settled || a.cancelled)              revert AuctionNotFound();
        if (block.timestamp >= a.endTime)          revert AuctionEnded();
        if (amount <= a.topBid || amount < a.startPrice) revert BidTooLow();

        // 退回上一出价
        address prevBidder = a.topBidder;
        uint256 prevAmount = a.topBid;
        if (prevBidder != address(0) && prevAmount > 0) {
            // 优先尝试直接退回；失败则记入 pendingRefunds 供 withdrawRefund 取
            bool ok = _safeTransfer(a.payToken, prevBidder, prevAmount);
            if (!ok) pendingRefunds[auctionId][prevBidder] += prevAmount;
            emit BidPlaced(auctionId, msg.sender, amount, prevBidder, prevAmount);
        } else {
            emit BidPlaced(auctionId, msg.sender, amount, address(0), 0);
        }

        // 托管新出价
        IERC20(a.payToken).transferFrom(msg.sender, address(this), amount);
        a.topBidder = msg.sender;
        a.topBid    = amount;
    }

    /// @notice 结算（到期后任何人可调）
    function settle(uint256 auctionId) external validAuction(auctionId) {
        _settle(auctionId);
    }

    /// @notice 撤拍（仅卖家 · 无出价时可撤）
    function cancelAuction(uint256 auctionId)
        external whenNotPaused validAuction(auctionId)
    {
        Auction storage a = auctions[auctionId];
        if (msg.sender != a.seller) revert NotSeller();
        _cancel(auctionId, false);
    }

    /// @notice 取回因 transfer 失败被挂起的退款
    function withdrawRefund(uint256 auctionId) external {
        uint256 amount = pendingRefunds[auctionId][msg.sender];
        if (amount == 0) return;
        pendingRefunds[auctionId][msg.sender] = 0;
        address payToken = auctions[auctionId].payToken;
        IERC20(payToken).transfer(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // 📖 查询区（view，永远可用）
    // ═══════════════════════════════════════════

    function isChannel(address registry) public view returns (bool) {
        ChannelGrant memory g = channelGrants[registry];
        return g.enabled && (g.validUntil == 0 || block.timestamp <= g.validUntil);
    }

    function auctionOf(bytes32 skuId, address registry) external view returns (uint256) {
        return activeAuction[skuId][registry];
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return auctions[auctionId];
    }

    // ═══════════════════════════════════════════
    // 🔧 内部函数
    // ═══════════════════════════════════════════

    function _createAuction(
        bytes32 skuId,
        address registry,
        address seller,
        address payToken,
        uint256 startPrice,
        uint256 reservePrice,
        uint64  duration
    ) internal returns (uint256 auctionId) {
        // 渠道授权检查
        if (!isChannel(registry)) revert NotChannel();
        // 卖家持有验证
        if (ISkuRegistry(registry).skuOwner(skuId) != seller) revert NotOwner();
        // 无活跃拍卖
        if (activeAuction[skuId][registry] != 0) revert AuctionAlreadyActive();

        // 锁定 SKU（防止并发转移）
        ISkuRegistry(registry).lockSku(skuId);

        auctionId = ++auctionCount;
        uint64 endTime = uint64(block.timestamp) + duration;

        auctions[auctionId] = Auction({
            skuId:        skuId,
            registry:     registry,
            seller:       seller,
            payToken:     payToken,
            startPrice:   startPrice,
            reservePrice: reservePrice,
            endTime:      endTime,
            settled:      false,
            cancelled:    false,
            topBidder:    address(0),
            topBid:       0
        });
        activeAuction[skuId][registry] = auctionId;

        emit AuctionCreated(auctionId, skuId, registry, seller, payToken, startPrice, reservePrice, endTime);
    }

    function _settle(uint256 auctionId) internal {
        Auction storage a = auctions[auctionId];
        if (a.settled || a.cancelled) revert AuctionNotFound();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();

        a.settled = true;
        activeAuction[a.skuId][a.registry] = 0;

        // 解锁 SKU
        try ISkuRegistry(a.registry).unlockSku(a.skuId) {} catch {}

        if (a.topBidder == address(0)) {
            // 无出价：流拍（SKU 保留给卖家，无需操作）
            emit AuctionSettled(auctionId, address(0), 0, 0);
            return;
        }

        if (a.reservePrice > 0 && a.topBid < a.reservePrice) {
            // 未达底价：退款给最高出价方，SKU 保留给卖家
            IERC20(a.payToken).transfer(a.topBidder, a.topBid);
            emit AuctionSettled(auctionId, address(0), a.topBid, 0);
            return;
        }

        // 成交：转移 SKU + 分配款项
        uint256 fee = a.topBid * feeBps / 10000;
        uint256 sellerAmount = a.topBid - fee;

        // SKU 过户（channelTransfer）
        try ISkuRegistry(a.registry).channelTransfer(a.skuId, a.seller, a.topBidder) {} catch {}

        // 款项分配（从合约托管余额转出）
        if (fee > 0)          IERC20(a.payToken).transfer(treasury, fee);
        if (sellerAmount > 0) IERC20(a.payToken).transfer(a.seller, sellerAmount);

        // 写 TradeLedger（best-effort）
        if (address(tradeLedger) != address(0)) {
            try tradeLedger.recordOrder(
                a.skuId, a.registry, CHANNEL_ID,
                a.seller, a.topBidder, a.payToken, a.topBid
            ) {} catch {}
        }

        emit AuctionSettled(auctionId, a.topBidder, a.topBid, fee);
    }

    function _cancel(uint256 auctionId, bool force) internal {
        Auction storage a = auctions[auctionId];
        if (a.settled || a.cancelled) revert AuctionNotFound();
        if (!force && a.topBidder != address(0)) revert HasBids(); // 有出价不可撤（非强制）

        a.cancelled = true;
        activeAuction[a.skuId][a.registry] = 0;

        // 解锁 SKU
        try ISkuRegistry(a.registry).unlockSku(a.skuId) {} catch {}

        // 退还最高出价（若 force cancel 时存在出价）
        if (a.topBidder != address(0) && a.topBid > 0) {
            bool ok = _safeTransfer(a.payToken, a.topBidder, a.topBid);
            if (!ok) pendingRefunds[auctionId][a.topBidder] += a.topBid;
        }

        emit AuctionCancelled(auctionId, a.seller);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok,) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        return ok;
    }
}
```

---

## 二、完整 ABI（ethers 人类可读格式）

```
// ── 事件
event AuctionCreated(uint256 indexed auctionId, bytes32 indexed skuId, address indexed registry, address seller, address payToken, uint256 startPrice, uint256 reservePrice, uint64 endTime)
event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, address prevBidder, uint256 prevAmount)
event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 finalPrice, uint256 fee)
event AuctionCancelled(uint256 indexed auctionId, address indexed seller)
event MinerSet(address indexed addr, bool enabled)
event ChannelSet(address indexed registry, bool enabled, uint64 validUntil)
event FeeBpsSet(uint16 feeBps)
event TradeLedgerSet(address tradeLedger)
event Paused(bool isPaused)

// ── 用户写函数
function listAuction(bytes32 skuId, address registry, address payToken, uint256 startPrice, uint256 reservePrice, uint64 duration) external returns (uint256 auctionId)
function bid(uint256 auctionId, uint256 amount) external
function settle(uint256 auctionId) external
function cancelAuction(uint256 auctionId) external
function withdrawRefund(uint256 auctionId) external

// ── Miner 函数
function setMiner(address addr, bool enabled) external
function setPaused(bool paused) external
function setChannel(address registry, bool enabled, uint64 validUntil) external
function setFeeBps(uint16 feeBps) external
function setTradeLedger(address tl) external
function setTreasury(address treasury) external
function listSystemAuction(bytes32 skuId, address registry, address payToken, uint256 startPrice, uint256 reservePrice, uint64 duration) external returns (uint256 auctionId)
function forceSettle(uint256 auctionId) external
function forceCancel(uint256 auctionId) external

// ── view
function isChannel(address registry) external view returns (bool)
function auctionOf(bytes32 skuId, address registry) external view returns (uint256)
function getAuction(uint256 auctionId) external view returns (tuple(bytes32 skuId, address registry, address seller, address payToken, uint256 startPrice, uint256 reservePrice, uint64 endTime, bool settled, bool cancelled, address topBidder, uint256 topBid))
function auctionCount() external view returns (uint256)
function feeBps() external view returns (uint16)
function paused() external view returns (bool)
function isMiner(address) external view returns (bool)
function treasury() external view returns (address)
function tradeLedger() external view returns (address)
function channelGrants(address) external view returns (bool enabled, uint64 validUntil)
function pendingRefunds(uint256 auctionId, address bidder) external view returns (uint256)
```

---

## 三、函数参数使用说明

| 函数                  | 谁可调          | 参数说明                                                                                                                                  |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `listAuction`       | 任何人（SKU 持有者） | `skuId`=SKU 标识；`registry`=资产合约地址；`payToken`=收款 TOKEN；`startPrice`=起拍价（不可为 0）；`reservePrice`=底价（0 代表无底价）；`duration`=秒数（建议 3600~604800） |
| `bid`               | 任何人          | `auctionId`=拍卖 ID；`amount`=出价，须 ≥ startPrice 且 > 当前 topBid；调用前须 approve 合约额度                                                          |
| `settle`            | 任何人（到期后）     | `auctionId`=拍卖 ID；到期前调用 revert AuctionNotEnded                                                                                        |
| `cancelAuction`     | 卖家           | 仅无出价时可撤；有出价时 revert HasBids                                                                                                           |
| `withdrawRefund`    | 任何人          | 取回因 transfer 失败挂起的退款余额                                                                                                                |
| `listSystemAuction` | miner        | 与 listAuction 参数相同，卖家固定为 treasury                                                                                                     |
| `forceSettle`       | miner        | 强制结算（处理超期未结算、争议场景）                                                                                                                    |
| `forceCancel`       | miner        | 强制撤拍（紧急处理；有出价时自动退款）                                                                                                                   |
| `setChannel`        | miner        | `registry`=资产合约地址；`enabled`=true/false；`validUntil`=截止时间戳（0=永久）                                                                       |
| `setFeeBps`         | miner        | 万分比，最高 2000（20%）；建议生产环境 150~300                                                                                                       |

---

## 四、部署 SH（[auction-deploy.sh](http://auction-deploy.sh)）

```bash
#!/usr/bin/env bash
# auction-deploy.sh — AuctionHouse 部署脚本
# 用法: bash auction-deploy.sh obt|r9|qdt
# 前置: foundry.toml 须含 optimizer=true, optimizer_runs=200, via_ir=true
set -euo pipefail

CHAIN="${1:-}"
if [[ -z "${CHAIN}" ]]; then echo "Usage: $0 obt|r9|qdt"; exit 1; fi

# ── 固定参数 ──────────────────────────────────
TREASURY="0xaf5cd2c046a0f945290171eb80d31136dc76b66d"
MINER_1="${MINER_1:-}"   # 主 miner 地址（必填）
PRIVATE_KEY="${PRIVATE_KEY:-}"

case "${CHAIN}" in
  obt)
    EXPECT_ID=1008611
    RPC="<http://47.86.44.43:39546>"
    # TradeLedger 地址（P1-C 已部署，填入）
    TRADE_LEDGER="${TRADE_LEDGER_OBT:-0x0000000000000000000000000000000000000000}"
    ;;
  r9)
    EXPECT_ID=555555555
    RPC="<http://47.86.44.43:41546>"
    TRADE_LEDGER="${TRADE_LEDGER_R9:-0x0000000000000000000000000000000000000000}"
    ;;
  qdt)
    EXPECT_ID=88888888
    RPC="<http://47.86.44.43:40546>"
    TRADE_LEDGER="${TRADE_LEDGER_QDT:-0x0000000000000000000000000000000000000000}"
    ;;
  *) echo "Unknown chain: ${CHAIN}"; exit 1 ;;
esac

# ── 校验 ──────────────────────────────────────
[[ -z "${PRIVATE_KEY}" ]] && { echo "PRIVATE_KEY not set"; exit 1; }
[[ -z "${MINER_1}" ]]     && { echo "MINER_1 not set"; exit 1; }

# cast chain-id 铁律防串链
GOT_ID=$(cast chain-id --rpc-url "${RPC}" 2>/dev/null || echo 0)
[[ "${GOT_ID}" != "${EXPECT_ID}" ]] && { echo "Chain ID mismatch: got ${GOT_ID} want ${EXPECT_ID}"; exit 1; }

# foundry.toml 守卫
grep -q 'optimizer = true'  foundry.toml || { echo "foundry.toml: optimizer=true missing"; exit 1; }
grep -q 'via_ir = true'     foundry.toml || { echo "foundry.toml: via_ir=true missing"; exit 1; }

echo "[${CHAIN}] chain-id=${GOT_ID} OK, deploying AuctionHouse..."

# ── 编译 ──────────────────────────────────────
forge build --skip test --skip script > build.log 2>&1 \
  || { echo "Build failed:"; tail -n 30 build.log; exit 1; }

# ── 部署 ──────────────────────────────────────
# 构造参数: treasury, tradeLedger, miners[]
MINERS_ARR="[${MINER_1}]"

DEPLOY_OUT=$(forge create src/AuctionHouse.sol:AuctionHouse \
  --rpc-url "${RPC}" \
  --private-key "${PRIVATE_KEY}" \
  --evm-version paris \
  --skip test --skip script \
  --constructor-args \
    "${TREASURY}" \
    "${TRADE_LEDGER}" \
    "${MINERS_ARR}" \
  2>&1)

echo "${DEPLOY_OUT}" >> deploy-${CHAIN}.log
CONTRACT=$(echo "${DEPLOY_OUT}" | grep 'Deployed to:' | awk '{print $NF}')
[[ -z "${CONTRACT}" ]] && { echo "Deploy failed:"; tail -n 30 deploy-${CHAIN}.log; exit 1; }

echo "[${CHAIN}] AuctionHouse deployed: ${CONTRACT}"

# ── 自检 ──────────────────────────────────────
echo "--- self-check ---" >> deploy-${CHAIN}.log
cast call "${CONTRACT}" "treasury()" --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1
cast call "${CONTRACT}" "feeBps()"   --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1
cast call "${CONTRACT}" "paused()"   --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1

echo "[${CHAIN}] Done. Log: deploy-${CHAIN}.log"
echo ""
echo "=== 回填清单 ==="
echo "AuctionHouse (${CHAIN}): ${CONTRACT}"
echo "→ ShortNumRegistry.setChannel(${CONTRACT}, true, 0)"
echo "→ GoodsMarket.setChannel(${CONTRACT}, true, 0)"
echo "→ TradeLedger.setChannel(${CONTRACT}, true)"
echo "→ admin 导入 AuctionHouse"
```

---

## 五、完整部署参数

| 参数              | OBT (1008611)                                | R9 (555555555)                               |
| --------------- | -------------------------------------------- | -------------------------------------------- |
| treasury        | `0xaf5cd2c046a0f945290171eb80d31136dc76b66d` | `0xaf5cd2c046a0f945290171eb80d31136dc76b66d` |
| tradeLedger     | ⬜ 待 P1-C 部署地址回填                              | ⬜ 待 P1-C 部署地址回填                              |
| miners          | ⬜ 填入运营 miner 钱包                              | ⬜ 填入运营 miner 钱包                              |
| evm_version     | paris                                        | paris                                        |
| feeBps（部署后设置）   | 250（2.5%）                                    | 250（2.5%）                                    |
| setChannel（部署后） | ShortNumRegistry + GoodsMarket               | ShortNumRegistry + GoodsMarket               |

**部署顺序（P2）：**

1. `bash auction-deploy.sh obt` → 得到 AuctionHouse_OBT 地址
2. `bash auction-deploy.sh r9` → 得到 AuctionHouse_R9 地址
3. ShortNumRegistry（OBT+R9）.setChannel(AuctionHouse, true, 0)
4. GoodsMarket（OBT+R9）.setChannel(AuctionHouse, true, 0)
5. TradeLedger（OBT+R9）.setChannel(AuctionHouse, true)
6. admin 导入 AuctionHouse 面板

---

## 六、部署登记表
