# RentalChannel.sol（租赁渠道合约 · ERC-4907语义 · channelId=5）

<aside>  
📜

**合约宪法 · RentalChannel（P1 · 2026-07-21）**

1. **定位**：SKU 租赁渠道；ERC-4907 语义——只转使用权（userOf/userExpires），所有权保留在出租方。
2. **奖励铁律**：不调 `_payReward / onPurchase`，渠道流水不纳入代理奖励。
3. **货款直付出租方**：`transferFrom(tenant, owner, totalRent)`；合约不托管资金。
4. **独占模式**：`exclusive=true` 时 `lockSku`，防止出租期间所有人转移；`endRental` 时 `unlockSku`。
5. **到期清理**：任何人可调 `reclaimExpired(skuId)` 清除过期用户权（不需要签名）。
6. **channelId = 5**；不涉及所有权转移，TradeLedger 记录租赁流水（seller=出租方，buyer=租客）。  
   
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

/// @title RentalChannel — 租赁渠道合约（ERC-4907 语义）
/// @notice channelId = 5
/// @notice 只转使用权；所有权不动；到期/endRental 清除用户权；独占模式可 lockSku。
/// @notice 奖励铁律：不调 _payReward，流水不纳入代理奖励。货款直付出租方。
contract RentalChannel {
    uint8 public constant CHANNEL_ID = 5;

    struct Rental {
        address owner;           // 出租方（SKU 持有人）
        address tenant;          // 租客
        address registry;
        bytes32 skuId;
        address payToken;
        uint256 pricePerPeriod;
        uint64  period;          // 每周期秒数
        uint64  startTime;
        uint64  endTime;
        bool    exclusive;       // true = 独占，lockSku
        bool    active;
    }

    mapping(bytes32 => Rental) public rentals;
    // ERC-4907-like 使用权
    mapping(bytes32 => address) public userOf;      // skuId => 当前租客
    mapping(bytes32 => uint64) public userExpires;  // skuId => 使用权到期时间

    uint256 public rentalNonce;

    mapping(address => bool) public isMiner;
    address[] private _miners;
    uint8 public constant MAX_MINERS = 3;
    bool public paused;
    bool public enabled;
    address public tradeLedger;

    event RentalStarted(bytes32 indexed rentalId, bytes32 indexed skuId, address indexed tenant,
        address owner, address registry, address payToken, uint256 paid, uint64 endTime);
    event RentalEnded(bytes32 indexed rentalId, bytes32 indexed skuId, address indexed by);
    event UserUpdated(bytes32 indexed skuId, address indexed user, uint64 expires);
    event EnabledSet(bool enabled);
    event TradeLedgerSet(address tradeLedger);
    event MinerAdded(address indexed miner);
    event MinerRemoved(address indexed miner);
    event Paused(bool paused);

    error NotMiner(); error ChannelDisabled(); error ChannelPaused();
    error NotSkuOwner(); error NotTenantOrOwner(); error RentalNotActive();
    error PayFailed(); error ZeroAddr(); error InvalidPeriod();
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

    /// @notice 出租：SKU 持有人发起；租客支付租金获得使用权
    /// @param registry     资产合约地址（ShortNumRegistry / GoodsMarket）
    /// @param skuId        SKU id
    /// @param tenant       租客地址
    /// @param payToken     支付币种
    /// @param pricePerPeriod 每周期租金
    /// @param period       周期长度（秒）
    /// @param units        购买周期数
    /// @param exclusive    是否独占（true = lockSku，防止出租期间所有人转移）
    function rent(
        address registry,
        bytes32 skuId,
        address tenant,
        address payToken,
        uint256 pricePerPeriod,
        uint64  period,
        uint32  units,
        bool    exclusive
    ) external whenEnabled returns (bytes32 rentalId) {
        if (tenant == address(0)) revert ZeroAddr();
        if (period == 0 || units == 0) revert InvalidPeriod();
        ISkuRegistry reg = ISkuRegistry(registry);
        if (reg.skuOwner(skuId) != msg.sender) revert NotSkuOwner();
        if (!reg.skuActive(skuId)) revert NotSkuOwner();
        // 租金：tenant → owner 直接转账
        uint256 totalRent = pricePerPeriod * uint256(units);
        if (payToken != address(0) && totalRent > 0) {
            if (!IERC20Min(payToken).transferFrom(tenant, msg.sender, totalRent)) revert PayFailed();
        }
        // 独占模式锁定
        if (exclusive) reg.lockSku(skuId);
        // 设置使用权
        uint64 endTime = uint64(block.timestamp) + period * uint64(units);
        userOf[skuId]      = tenant;
        userExpires[skuId] = endTime;
        emit UserUpdated(skuId, tenant, endTime);
        // 存租赁记录
        rentalNonce++;
        rentalId = keccak256(abi.encode(block.chainid, msg.sender, skuId, rentalNonce));
        rentals[rentalId] = Rental({
            owner:          msg.sender,
            tenant:         tenant,
            registry:       registry,
            skuId:          skuId,
            payToken:       payToken,
            pricePerPeriod: pricePerPeriod,
            period:         period,
            startTime:      uint64(block.timestamp),
            endTime:        endTime,
            exclusive:      exclusive,
            active:         true
        });
        _recordOrder(skuId, registry, msg.sender, tenant, payToken, totalRent);
        emit RentalStarted(rentalId, skuId, tenant, msg.sender, registry, payToken, totalRent, endTime);
    }

    /// @notice 结束租赁：清除使用权，独占时解锁 SKU
    /// @dev 租客只能在到期后调用（提前退租需出租方或 miner）
    function endRental(bytes32 rentalId) external {
        Rental storage r = rentals[rentalId];
        if (!r.active) revert RentalNotActive();
        bool isTenant = msg.sender == r.tenant;
        bool isOwner  = msg.sender == r.owner;
        bool isMiner_ = isMiner[msg.sender];
        if (!isTenant && !isOwner && !isMiner_) revert NotTenantOrOwner();
        // 租客提前退租：拒绝（只有 owner/miner 可提前终止）
        if (isTenant && !isOwner && !isMiner_ && block.timestamp < r.endTime) revert NotTenantOrOwner();
        r.active = false;
        delete userOf[r.skuId];
        delete userExpires[r.skuId];
        emit UserUpdated(r.skuId, address(0), 0);
        if (r.exclusive) { try ISkuRegistry(r.registry).unlockSku(r.skuId) {} catch {} }
        emit RentalEnded(rentalId, r.skuId, msg.sender);
    }

    /// @notice 任何人可清理过期使用权（无需签名，链下 keeper 可调）
    function reclaimExpired(bytes32 skuId) external {
        if (userExpires[skuId] > 0 && block.timestamp >= userExpires[skuId]) {
            delete userOf[skuId];
            delete userExpires[skuId];
            emit UserUpdated(skuId, address(0), 0);
        }
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
'function rent(address registry, bytes32 skuId, address tenant, address payToken, uint256 pricePerPeriod, uint64 period, uint32 units, bool exclusive) returns (bytes32 rentalId)',
'function endRental(bytes32 rentalId)',
'function reclaimExpired(bytes32 skuId)',
// 查询
'function rentals(bytes32) view returns (address owner, address tenant, address registry, bytes32 skuId, address payToken, uint256 pricePerPeriod, uint64 period, uint64 startTime, uint64 endTime, bool exclusive, bool active)',
'function userOf(bytes32 skuId) view returns (address)',
'function userExpires(bytes32 skuId) view returns (uint64)',
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
'event RentalStarted(bytes32 indexed rentalId, bytes32 indexed skuId, address indexed tenant, address owner, address registry, address payToken, uint256 paid, uint64 endTime)',
'event RentalEnded(bytes32 indexed rentalId, bytes32 indexed skuId, address indexed by)',
'event UserUpdated(bytes32 indexed skuId, address indexed user, uint64 expires)',
```

## 三、部署脚本（[rental-channel-deploy.sh](http://rental-channel-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail
# 用法：export PK=0x私钥 TRADELEDGER=0x台账地址 && bash rental-channel-deploy.sh <r9|obt|qdt>
CHAIN="${1:?用法: bash rental-channel-deploy.sh <r9|obt|qdt>}"
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
LOG="rental-deploy.${CHAIN}.$(date +%s).log"
forge build --skip test --skip script >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
forge create src/RentalChannel.sol:RentalChannel \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --evm-version shanghai \
  --skip test --skip script \
  --constructor-args "$TRADELEDGER" "[${DEPLOYER}]" >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
ADDR="$(grep 'Deployed to:' "$LOG" | tail -1 | sed 's/Deployed to: //')"
echo "RentalChannel_${CHAIN}=${ADDR}"
# 部署后：ShortNumRegistry.setChannel(ADDR, true, 0)
# 部署后：GoodsMarket.setChannel(ADDR, true, 0)
# 部署后：TradeLedger.setChannel(ADDR, true)
# 部署后：miner 调 setEnabled(true)
echo "$(date +%F_%T),$CHAIN,$EXPECT_ID,RentalChannel,$ADDR" >> rental-deploy.log
```

## 四、部署参数

| 步骤               | 操作                                            |
| ---------------- | --------------------------------------------- |
| 构造参数             | `tradeLedger_`=TradeLedger 地址；`miners_`=[部署者] |
| ShortNumRegistry | `setChannel(RentalChannel, true, 0)`          |
| GoodsMarket      | `setChannel(RentalChannel, true, 0)`          |
| TradeLedger      | `setChannel(RentalChannel, true)`             |
| RentalChannel    | miner 调 `setEnabled(true)`                    |

## 五、部署登记表
