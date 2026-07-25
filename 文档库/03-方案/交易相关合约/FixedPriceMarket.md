# FixedPriceMarket.sol（一口价转卖渠道合约 · channelId=2）

<aside>  
📜

**合约宪法 · FixedPriceMarket（P1 · 2026-07-21）**

1. **定位**：SKU 二级流转渠道之一；卖家挂单（lockSku）→ 买家一口价购买（transferFrom buyer→seller + channelTransfer）→ 自动解锁。
2. **奖励铁律**：不调 `_payReward / onPurchase`，渠道流水不纳入代理奖励。
3. **货款直付卖家**：`transferFrom(buyer, seller, price)`；合约不托管任何资金。
4. **miner 管开关**：`enabled` 默认 false（关）；miner `setEnabled(true)` 开启。
5. **锁定语义**：`listSku` 时调 `lockSku` 防止卖家同时挂双单或直接 transfer；`buyListed / cancelListing / forceCloseListing` 均调 `unlockSku`。
6. **channelId = 2**。  
   
   </aside>

## 一、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
interface ISkuRegistry {
    function skuOwner(bytes32 skuId) external view returns (address);
    function skuActive(bytes32 skuId) external view returns (bool);
    function channelTransfer(bytes32 skuId, address from, address to) external;
    function lockSku(bytes32 skuId) external;
    function unlockSku(bytes32 skuId) external;
}
interface ITradeLedger {
    function recordOrder(bytes32 skuId, address registry, uint8 channelId,
        address seller, address buyer, address payToken, uint256 price_) external returns (bytes32);
}

/// @title FixedPriceMarket — 一口价转卖渠道合约
/// @notice channelId = 2
/// @notice 卖家挂单锁定 SKU → 买家付款直达卖家 + channelTransfer 自动交割。
/// @notice 奖励铁律：不调 _payReward，流水不纳入代理奖励。
contract FixedPriceMarket {
    uint8 public constant CHANNEL_ID = 2;

    struct Listing {
        address seller;
        address registry;
        bytes32 skuId;
        address payToken;
        uint256 price;
        uint64  expiry;   // 0 = 不过期
        bool    active;
    }

    mapping(bytes32 => Listing) public listings;
    uint256 public listingNonce;

    mapping(address => bool) public isMiner;
    address[] private _miners;
    uint8 public constant MAX_MINERS = 3;
    bool public paused;
    bool public enabled;  // 默认 false=关
    address public tradeLedger;

    event Listed(bytes32 indexed listingId, bytes32 indexed skuId, address indexed seller,
        address registry, address payToken, uint256 price, uint64 expiry);
    event Sold(bytes32 indexed listingId, bytes32 indexed skuId, address indexed buyer,
        address seller, address payToken, uint256 price);
    event Cancelled(bytes32 indexed listingId, address indexed by);
    event ForceClosed(bytes32 indexed listingId, address indexed by);
    event EnabledSet(bool enabled);
    event TradeLedgerSet(address tradeLedger);
    event MinerAdded(address indexed miner);
    event MinerRemoved(address indexed miner);
    event Paused(bool paused);

    error NotMiner(); error ChannelDisabled(); error ChannelPaused();
    error NotSeller(); error ListingNotActive(); error ListingExpired();
    error PayFailed(); error ZeroAddr(); error InvalidPrice(); error NotSkuOwner();
    error MinerExists(); error MinerNotFound(); error TooManyMiners(); error CannotRemoveLastMiner();

    constructor(address tradeLedger_, address[] memory miners_) {
        if (tradeLedger_ != address(0)) tradeLedger = tradeLedger_;
        require(miners_.length > 0 && miners_.length <= MAX_MINERS);
        for (uint256 i; i < miners_.length; ++i) {
            if (miners_[i] != address(0) && !isMiner[miners_[i]]) {
                isMiner[miners_[i]] = true;
                _miners.push(miners_[i]);
            }
        }
    }

    modifier onlyMiner() { if (!isMiner[msg.sender]) revert NotMiner(); _; }
    modifier whenEnabled() {
        if (!enabled) revert ChannelDisabled();
        if (paused) revert ChannelPaused();
        _;
    }

    /// @notice 卖家挂单：锁定 SKU，等待买家成交
    function listSku(
        address registry,
        bytes32 skuId,
        address payToken,
        uint256 price,
        uint64 expiry
    ) external whenEnabled returns (bytes32 listingId) {
        if (payToken == address(0)) revert ZeroAddr();
        if (price == 0) revert InvalidPrice();
        ISkuRegistry reg = ISkuRegistry(registry);
        if (reg.skuOwner(skuId) != msg.sender) revert NotSkuOwner();
        if (!reg.skuActive(skuId)) revert NotSkuOwner();
        reg.lockSku(skuId);  // 防止直接 transfer 或重复挂单
        listingNonce++;
        listingId = keccak256(abi.encode(block.chainid, msg.sender, skuId, listingNonce));
        listings[listingId] = Listing({
            seller:   msg.sender,
            registry: registry,
            skuId:    skuId,
            payToken: payToken,
            price:    price,
            expiry:   expiry,
            active:   true
        });
        emit Listed(listingId, skuId, msg.sender, registry, payToken, price, expiry);
    }

    /// @notice 买家购买：付款直达卖家，执行 channelTransfer
    function buyListed(bytes32 listingId) external whenEnabled {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (l.expiry > 0 && block.timestamp > l.expiry) revert ListingExpired();
        l.active = false;
        // 款项：buyer → seller 直接转账
        if (!IERC20Min(l.payToken).transferFrom(msg.sender, l.seller, l.price)) revert PayFailed();
        // 解锁并过户
        ISkuRegistry reg = ISkuRegistry(l.registry);
        reg.unlockSku(l.skuId);
        reg.channelTransfer(l.skuId, l.seller, msg.sender);
        // 写台账
        _recordOrder(l.skuId, l.registry, l.seller, msg.sender, l.payToken, l.price);
        emit Sold(listingId, l.skuId, msg.sender, l.seller, l.payToken, l.price);
    }

    /// @notice 卖家撤单（或 miner 强制撤单）
    function cancelListing(bytes32 listingId) external {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (msg.sender != l.seller && !isMiner[msg.sender]) revert NotSeller();
        l.active = false;
        ISkuRegistry(l.registry).unlockSku(l.skuId);
        emit Cancelled(listingId, msg.sender);
    }

    /// @notice 强制关单：当 SKU 已不再有效时（过期/被 miner 删除）任何人可调
    function forceCloseListing(bytes32 listingId) external {
        Listing storage l = listings[listingId];
        if (!l.active) return;
        ISkuRegistry reg = ISkuRegistry(l.registry);
        if (!isMiner[msg.sender]) {
            require(!reg.skuActive(l.skuId), "FPM: sku still active");
        }
        l.active = false;
        try reg.unlockSku(l.skuId) {} catch {}  // best-effort
        emit ForceClosed(listingId, msg.sender);
    }

    // ---- config ----
    function setEnabled(bool v) external onlyMiner { enabled = v; emit EnabledSet(v); }
    function setPaused(bool v) external onlyMiner { paused = v; emit Paused(v); }
    function setTradeLedger(address tl) external onlyMiner { tradeLedger = tl; emit TradeLedgerSet(tl); }
    function addMiner(address m) external onlyMiner {
        if (m == address(0)) revert ZeroAddr();
        if (isMiner[m]) revert MinerExists();
        if (_miners.length >= MAX_MINERS) revert TooManyMiners();
        isMiner[m] = true; _miners.push(m); emit MinerAdded(m);
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

    // view
    function getListing(bytes32 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    // ---- internal ----
    function _recordOrder(
        bytes32 skuId, address registry,
        address seller, address buyer,
        address payToken, uint256 price_
    ) internal {
        if (tradeLedger == address(0)) return;
        try ITradeLedger(tradeLedger).recordOrder(
            skuId, registry, CHANNEL_ID, seller, buyer, payToken, price_
        ) {} catch {}
    }
}
```

## 二、ABI（human-readable）

```jsx
// 用户写
'function listSku(address registry, bytes32 skuId, address payToken, uint256 price, uint64 expiry) returns (bytes32 listingId)',
'function buyListed(bytes32 listingId)',
'function cancelListing(bytes32 listingId)',
'function forceCloseListing(bytes32 listingId)',
// 查询
'function getListing(bytes32 listingId) view returns (tuple(address seller, address registry, bytes32 skuId, address payToken, uint256 price, uint64 expiry, bool active))',
'function listings(bytes32) view returns (address seller, address registry, bytes32 skuId, address payToken, uint256 price, uint64 expiry, bool active)',
'function enabled() view returns (bool)',
'function paused() view returns (bool)',
'function isMiner(address) view returns (bool)',
// miner
'function setEnabled(bool)',
'function setPaused(bool)',
'function setTradeLedger(address)',
'function addMiner(address)',
'function removeMiner(address)',
'function getMiners() view returns (address[])',
// events
'event Listed(bytes32 indexed listingId, bytes32 indexed skuId, address indexed seller, address registry, address payToken, uint256 price, uint64 expiry)',
'event Sold(bytes32 indexed listingId, bytes32 indexed skuId, address indexed buyer, address seller, address payToken, uint256 price)',
'event Cancelled(bytes32 indexed listingId, address indexed by)',
'event ForceClosed(bytes32 indexed listingId, address indexed by)',
```

## 三、部署脚本（[fixed-price-deploy.sh](http://fixed-price-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail
# 用法：export PK=0x私钥 TRADELEDGER=0x台账地址 && bash fixed-price-deploy.sh <r9|obt|qdt>
CHAIN="${1:?用法: bash fixed-price-deploy.sh <r9|obt|qdt>}"
case "$CHAIN" in
  r9)  EXPECT_ID=555555555;  RPC="${RPC:-<http://47.86.44.43:41546>}" ;;
  obt) EXPECT_ID=1008611;    RPC="${RPC:-<http://47.86.44.43:39546>}" ;;
  qdt) EXPECT_ID=88888888;   RPC="${RPC:-<http://47.86.44.43:40546>}" ;;
  *) echo "unknown chain"; exit 1 ;;
esac
PK="${PK:?请先 export PK=0x私钥}"
TRADELEDGER="${TRADELEDGER:?请先 export TRADELEDGER=0x台账地址}"
DEPLOYER="$(cast wallet address --private-key "$PK")"
ACTUAL="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL" = "$EXPECT_ID" ] || { echo "❌ chainId 不符 $ACTUAL ≠ $EXPECT_ID"; exit 1; }
LOG="fpm-deploy.${CHAIN}.$(date +%s).log"
forge build --skip test --skip script >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
forge create src/FixedPriceMarket.sol:FixedPriceMarket \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --evm-version shanghai \
  --skip test --skip script \
  --constructor-args "$TRADELEDGER" "[${DEPLOYER}]" >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
ADDR="$(grep 'Deployed to:' "$LOG" | tail -1 | sed 's/Deployed to: //')"
echo "FixedPriceMarket_${CHAIN}=${ADDR}"
# 部署后：ShortNumRegistry.setChannel(ADDR, true, 0)
# 部署后：GoodsMarket.setChannel(ADDR, true, 0)
# 部署后：TradeLedger.setChannel(ADDR, true)
# 部署后：miner 调 setEnabled(true)
echo "$(date +%F_%T),$CHAIN,$EXPECT_ID,FixedPriceMarket,$ADDR" >> fpm-deploy.log
```

## 四、部署参数

| 步骤               | 操作                                            |
| ---------------- | --------------------------------------------- |
| 构造参数             | `tradeLedger_`=TradeLedger 地址；`miners_`=[部署者] |
| ShortNumRegistry | `setChannel(FixedPriceMarket, true, 0)`       |
| GoodsMarket      | `setChannel(FixedPriceMarket, true, 0)`       |
| TradeLedger      | `setChannel(FixedPriceMarket, true)`          |
| FixedPriceMarket | miner 调 `setEnabled(true)`                    |

## 五、部署登记表
