# GiftChannel.sol（有偿/无偿赠送渠道合约 · channelId=1）

<aside>  
📜

**合约宪法 · GiftChannel（P1 · 2026-07-21）**

1. **定位**：SKU 二级流转渠道之一；有偿赠送（号主付手续费）+ 系统无偿批量赠送（miner/活动合约）。
2. **奖励铁律**：本合约一律不调 `_payReward / onPurchase`；渠道流水不纳入代理奖励。
3. **货款直付**：有偿赠送手续费直付 treasury；合约不持任何用户资金。
4. **miner 管开关**：`enabled` 默认 false（关）；miner `setEnabled(true)` 开启。
5. **directTransferEnabled**：GiftChannel 上线后可在 ShortNumRegistry 调 `setDirectTransferEnabled(false)` 关闭 transfer() 强制走渠道；或保持 true 两者并存。
6. **channelId = 1**；写入 TradeLedger 时传此值。  
   
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

/// @title GiftChannel — 有偿/无偿赠送渠道合约
/// @notice channelId = 1
/// @notice 有偿：号主付手续费 + GAS，受赠人免费获得 SKU。无偿：miner/活动合约批量赠。
/// @notice 奖励铁律：不调 _payReward，流水不纳入代理奖励。货款直付 treasury。
contract GiftChannel {
    uint8 public constant CHANNEL_ID = 1;

    struct FeeConfig {
        address token;    // address(0) = 免费赠送
        uint256 amount;   // 每次手续费
        address treasury; // 收款地址
    }
    FeeConfig public feeConfig;

    mapping(address => bool) public isMiner;
    address[] private _miners;
    uint8 public constant MAX_MINERS = 3;
    bool public paused;
    bool public enabled;  // 默认 false=关，miner setEnabled 开
    mapping(address => bool) public isBatchSender;  // miner 或授权活动合约
    address public tradeLedger;

    event Gifted(bytes32 indexed skuId, address indexed registry, address indexed from, address to, address payToken, uint256 fee);
    event BatchGifted(bytes32[] skuIds, address indexed registry, address indexed to, uint256 count);
    event FeeConfigSet(address token, uint256 amount, address treasury);
    event EnabledSet(bool enabled);
    event BatchSenderSet(address indexed addr, bool enabled);
    event TradeLedgerSet(address tradeLedger);
    event MinerAdded(address indexed miner);
    event MinerRemoved(address indexed miner);
    event Paused(bool paused);

    error NotMiner(); error ChannelDisabled(); error ChannelPaused(); error NotSkuOwner();
    error PayFailed(); error ZeroAddr(); error NotBatchSender();
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

    /// @notice 有偿赠送：SKU 持有人调用，支付手续费后 SKU 转给 recipient
    function gift(address registry, bytes32 skuId, address recipient) external whenEnabled {
        if (recipient == address(0)) revert ZeroAddr();
        ISkuRegistry reg = ISkuRegistry(registry);
        if (reg.skuOwner(skuId) != msg.sender) revert NotSkuOwner();
        if (!reg.skuActive(skuId)) revert NotSkuOwner();
        FeeConfig memory fc = feeConfig;
        if (fc.token != address(0) && fc.amount > 0) {
            if (!IERC20Min(fc.token).transferFrom(msg.sender, fc.treasury, fc.amount)) revert PayFailed();
        }
        reg.channelTransfer(skuId, msg.sender, recipient);
        _recordOrder(skuId, registry, msg.sender, recipient, fc.token, fc.amount);
        emit Gifted(skuId, registry, msg.sender, recipient, fc.token, fc.amount);
    }

    /// @notice 系统无偿批量赠送：miner 或授权活动合约调用，不收手续费
    function batchGift(address registry, bytes32[] calldata skuIds, address recipient) external {
        if (!isMiner[msg.sender] && !isBatchSender[msg.sender]) revert NotBatchSender();
        if (paused) revert ChannelPaused();
        if (recipient == address(0)) revert ZeroAddr();
        ISkuRegistry reg = ISkuRegistry(registry);
        uint256 count;
        for (uint256 i; i < skuIds.length; ++i) {
            address owner = reg.skuOwner(skuIds[i]);
            if (owner == address(0)) continue;
            try reg.channelTransfer(skuIds[i], owner, recipient) {
                _recordOrder(skuIds[i], registry, owner, recipient, address(0), 0);
                count++;
            } catch {}
        }
        emit BatchGifted(skuIds, registry, recipient, count);
    }

    // ---- config ----
    function setFeeConfig(address token, uint256 amount, address treasury_) external onlyMiner {
        feeConfig = FeeConfig(token, amount, treasury_);
        emit FeeConfigSet(token, amount, treasury_);
    }
    function setEnabled(bool v) external onlyMiner { enabled = v; emit EnabledSet(v); }
    function setPaused(bool v) external onlyMiner { paused = v; emit Paused(v); }
    function setBatchSender(address addr, bool v) external onlyMiner {
        isBatchSender[addr] = v; emit BatchSenderSet(addr, v);
    }
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
// 用户
'function gift(address registry, bytes32 skuId, address recipient)',
// miner/batchSender
'function batchGift(address registry, bytes32[] skuIds, address recipient)',
// config（onlyMiner）
'function setFeeConfig(address token, uint256 amount, address treasury)',
'function setEnabled(bool)',
'function setPaused(bool)',
'function setBatchSender(address addr, bool enabled)',
'function setTradeLedger(address)',
'function addMiner(address)',
'function removeMiner(address)',
// view
'function feeConfig() view returns (address token, uint256 amount, address treasury)',
'function enabled() view returns (bool)',
'function paused() view returns (bool)',
'function isMiner(address) view returns (bool)',
'function isBatchSender(address) view returns (bool)',
'function tradeLedger() view returns (address)',
'function getMiners() view returns (address[])',
// events
'event Gifted(bytes32 indexed skuId, address indexed registry, address indexed from, address to, address payToken, uint256 fee)',
'event BatchGifted(bytes32[] skuIds, address indexed registry, address indexed to, uint256 count)',
```

## 三、部署脚本（[gift-channel-deploy.sh](http://gift-channel-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail
# 用法：export PK=0x私钥 TRADELEDGER=0x台账地址 && bash gift-channel-deploy.sh <r9|obt|qdt>
CHAIN="${1:?用法: bash gift-channel-deploy.sh <r9|obt|qdt>}"
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
LOG="gift-deploy.${CHAIN}.$(date +%s).log"
forge build --skip test --skip script >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
forge create src/GiftChannel.sol:GiftChannel \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --evm-version shanghai \
  --skip test --skip script \
  --constructor-args "$TRADELEDGER" "[${DEPLOYER}]" >>"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
ADDR="$(grep 'Deployed to:' "$LOG" | tail -1 | sed 's/Deployed to: //')"
echo "GiftChannel_${CHAIN}=${ADDR}"
# 部署后：在 ShortNumRegistry 调 setChannel(ADDR, true, 0)
# 部署后：在 TradeLedger 调 setChannel(ADDR, true)
# 部署后：miner 调 setEnabled(true) 开启渠道
echo "$(date +%F_%T),$CHAIN,$EXPECT_ID,GiftChannel,$ADDR" >> gift-deploy.log
```

## 四、部署参数 & 授权清单

| 步骤               | 操作                                                               |
| ---------------- | ---------------------------------------------------------------- |
| 构造参数             | `tradeLedger_`=TradeLedger 地址；`miners_`=[部署者]                    |
| ShortNumRegistry | `setChannel(GiftChannel, true, 0)`                               |
| TradeLedger      | `setChannel(GiftChannel, true)`                                  |
| GoodsMarket      | `setChannel(GiftChannel, true, 0)`                               |
| GiftChannel      | miner 调 `setEnabled(true)` 正式开启                                  |
| 可选               | ShortNumRegistry `setDirectTransferEnabled(false)` 关闭直接 transfer |

## 五、部署登记表
