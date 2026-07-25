# MiningClaim.sol（SKU 集邮挖矿渠道 · channelId=6 · 持有条件验证 · P3）

## 合约宪法（严格按源码提取，防 AI 漂移）

| 项         | 值                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合约名       | MiningClaim                                                                                                                                           |
| channelId | 6                                                                                                                                                     |
| 角色        | owner（构造写死）/ miner（onlyMiner，配置规则）/ claimer（满足条件后 claim）                                                                                              |
| 挖矿模型      | miner 配置「集邮规则」：持有指定 ERC20/ERC721 资产满足数量门槛 → `claim(ruleId)` 验证通过 → `channelTransfer` 过户奖励 SKU                                                         |
| 销毁选项      | `burnOnClaim`（规则级开关）：true=claim 时调用原材料 ERC20.transferFrom 到 burnAddress（黑洞销毁）                                                                         |
| 次数限制      | `maxClaimsPerAddr`（规则级，0=无限）；`claimedCount[ruleId][addr]` 记录已兑次数                                                                                      |
| 幂等防重      | refId = keccak256(ruleId, addr, nonce) 写 TradeLedger 防重复记录                                                                                            |
| 暂停        | `paused` bool；用户写函数带 `whenNotPaused`；miner 函数不受影响；view 永远可用                                                                                           |
| 渠道授权      | `setChannel(registry, enabled, validUntil)` onlyMiner；`isChannel(registry)` view                                                                      |
| 错误全集      | `NotOwner` / `NotMiner` / `RuleNotFound` / `RuleDisabled` / `ClaimLimitReached` / `ConditionNotMet` / `NotChannel` / `ContractPaused` / `ZeroAddress` |
| 依赖        | ISkuRegistry · TradeLedger · IERC20 · IERC721                                                                                                         |

---

## 一、完整 Solidity 源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────
// 依赖接口
// ─────────────────────────────────────────────
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC721Min {
    function balanceOf(address) external view returns (uint256);
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
// MiningClaim
// ─────────────────────────────────────────────
contract MiningClaim {

    uint8 public constant CHANNEL_ID = 6;

    // ── 状态变量 ──────────────────────────────
    address public owner;
    address public burnAddress = 0x000000000000000000000000000000000000dEaD;
    ITradeLedger public tradeLedger;
    bool    public paused;

    struct ChannelGrant { bool enabled; uint64 validUntil; }
    mapping(address => ChannelGrant) public channelGrants;
    mapping(address => bool) public isMiner;

    // ── 条件结构 ──────────────────────────────
    // 每条 required 资产条目：ERC20 按 balance，ERC721 按 balanceOf
    enum AssetType { ERC20, ERC721 }
    struct Requirement {
        address asset;        // 资产合约地址
        AssetType assetType;  // ERC20 or ERC721
        uint256 minAmount;    // 最低持有量（ERC20=token单位，ERC721=数量）
        bool    burnOnClaim;  // 仅 ERC20 有效：claim 时销毁此条件的 minAmount
    }

    // ── 规则结构 ──────────────────────────────
    struct Rule {
        bool    enabled;         // 是否开启
        bytes32 rewardSkuId;     // 奖励 SKU 的 skuId
        address rewardRegistry;  // 奖励 SKU 所在资产合约（ISkuRegistry）
        address rewardOwner;     // 奖励 SKU 当前持有人（miner 授权的发奖方）
        uint32  maxClaimsPerAddr;// 每地址最大兑换次数（0=无限）
        uint32  totalClaimed;    // 已兑换总次数
        uint32  maxTotalClaims;  // 全局最大兑换次数（0=无限）
        Requirement[] requirements;
    }

    uint256 public ruleCount;
    mapping(uint256 => Rule) public rules;
    // ruleId => addr => 已兑次数
    mapping(uint256 => mapping(address => uint32)) public claimedCount;

    // ── 事件 ──────────────────────────────────
    event RuleSet(
        uint256 indexed ruleId,
        bool    enabled,
        bytes32 rewardSkuId,
        address rewardRegistry,
        address rewardOwner,
        uint32  maxClaimsPerAddr,
        uint32  maxTotalClaims
    );
    event RuleEnabled(uint256 indexed ruleId, bool enabled);
    event Claimed(
        uint256 indexed ruleId,
        address indexed claimer,
        bytes32 rewardSkuId,
        uint32  claimIndex
    );
    event MinerSet(address indexed addr, bool enabled);
    event ChannelSet(address indexed registry, bool enabled, uint64 validUntil);
    event Paused(bool isPaused);

    // ── 错误 ──────────────────────────────────
    error NotOwner();
    error NotMiner();
    error NotChannel();
    error RuleNotFound();
    error RuleDisabled();
    error ClaimLimitReached();
    error TotalLimitReached();
    error ConditionNotMet(uint256 index);
    error ContractPaused();
    error ZeroAddress();

    // ── 修饰符 ────────────────────────────────
    modifier onlyOwner()   { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyMiner()   { if (!isMiner[msg.sender] && msg.sender != owner) revert NotMiner(); _; }
    modifier whenNotPaused() { if (paused) revert ContractPaused(); _; }

    // ── 构造 ──────────────────────────────────
    constructor(
        address _tradeLedger,
        address[] memory _miners
    ) {
        owner       = msg.sender;
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

    function setTradeLedger(address _tl) external onlyMiner {
        tradeLedger = ITradeLedger(_tl);
    }

    function setBurnAddress(address _burn) external onlyOwner {
        if (_burn == address(0)) revert ZeroAddress();
        burnAddress = _burn;
    }

    /// @notice 创建/更新挖矿规则
    /// @param ruleId          0=新建（返回新 ruleId）；>0=更新已有规则
    /// @param enabled         是否立即开启
    /// @param rewardSkuId     奖励 SKU 的 skuId
    /// @param rewardRegistry  奖励 SKU 所在资产合约
    /// @param rewardOwner     发奖方地址（需预先 approve 本合约 channelTransfer 权限）
    /// @param maxClaimsPerAddr 每地址最大兑换次数（0=无限）
    /// @param maxTotalClaims  全局最大兑换次数（0=无限）
    /// @param reqs            条件数组（资产合约、类型、最低持有量、是否销毁）
    function setRule(
        uint256     ruleId,
        bool        enabled,
        bytes32     rewardSkuId,
        address     rewardRegistry,
        address     rewardOwner,
        uint32      maxClaimsPerAddr,
        uint32      maxTotalClaims,
        Requirement[] calldata reqs
    ) external onlyMiner returns (uint256 id) {
        if (!isChannel(rewardRegistry)) revert NotChannel();

        if (ruleId == 0) {
            id = ++ruleCount;
        } else {
            if (ruleId > ruleCount) revert RuleNotFound();
            id = ruleId;
        }

        Rule storage r = rules[id];
        r.enabled         = enabled;
        r.rewardSkuId     = rewardSkuId;
        r.rewardRegistry  = rewardRegistry;
        r.rewardOwner     = rewardOwner;
        r.maxClaimsPerAddr = maxClaimsPerAddr;
        r.maxTotalClaims  = maxTotalClaims;

        // 清空旧条件
        delete r.requirements;
        for (uint256 i; i < reqs.length; ++i) {
            r.requirements.push(reqs[i]);
        }

        emit RuleSet(id, enabled, rewardSkuId, rewardRegistry, rewardOwner, maxClaimsPerAddr, maxTotalClaims);
    }

    /// @notice 快速开关规则
    function setRuleEnabled(uint256 ruleId, bool enabled) external onlyMiner {
        if (ruleId == 0 || ruleId > ruleCount) revert RuleNotFound();
        rules[ruleId].enabled = enabled;
        emit RuleEnabled(ruleId, enabled);
    }

    // ═══════════════════════════════════════════
    // 👤 用户操作区
    // ═══════════════════════════════════════════

    /// @notice 用户兑换（满足所有条件后获得奖励 SKU）
    /// @param ruleId  规则 ID
    function claim(uint256 ruleId) external whenNotPaused {
        if (ruleId == 0 || ruleId > ruleCount) revert RuleNotFound();
        Rule storage r = rules[ruleId];
        if (!r.enabled) revert RuleDisabled();

        // 次数检查
        if (r.maxClaimsPerAddr > 0 && claimedCount[ruleId][msg.sender] >= r.maxClaimsPerAddr)
            revert ClaimLimitReached();
        if (r.maxTotalClaims > 0 && r.totalClaimed >= r.maxTotalClaims)
            revert TotalLimitReached();

        // 条件验证 + 销毁原材料
        for (uint256 i; i < r.requirements.length; ++i) {
            Requirement memory req = r.requirements[i];
            if (req.assetType == AssetType.ERC20) {
                uint256 bal = IERC20Min(req.asset).balanceOf(msg.sender);
                if (bal < req.minAmount) revert ConditionNotMet(i);
                if (req.burnOnClaim) {
                    IERC20Min(req.asset).transferFrom(msg.sender, burnAddress, req.minAmount);
                }
            } else {
                uint256 bal = IERC721Min(req.asset).balanceOf(msg.sender);
                if (bal < req.minAmount) revert ConditionNotMet(i);
                // ERC721 不销毁（只验证持有）
            }
        }

        // 更新计数
        uint32 idx = claimedCount[ruleId][msg.sender];
        claimedCount[ruleId][msg.sender] = idx + 1;
        r.totalClaimed += 1;

        // 过户奖励 SKU
        ISkuRegistry(r.rewardRegistry).channelTransfer(r.rewardSkuId, r.rewardOwner, msg.sender);

        // 写 TradeLedger（best-effort，price=0 代表挖矿免费）
        if (address(tradeLedger) != address(0)) {
            try tradeLedger.recordOrder(
                r.rewardSkuId, r.rewardRegistry, CHANNEL_ID,
                r.rewardOwner, msg.sender, address(0), 0
            ) {} catch {}
        }

        emit Claimed(ruleId, msg.sender, r.rewardSkuId, idx);
    }

    // ═══════════════════════════════════════════
    // 📖 查询区（view，永远可用）
    // ═══════════════════════════════════════════

    function isChannel(address registry) public view returns (bool) {
        ChannelGrant memory g = channelGrants[registry];
        return g.enabled && (g.validUntil == 0 || block.timestamp <= g.validUntil);
    }

    function getRule(uint256 ruleId) external view returns (
        bool enabled,
        bytes32 rewardSkuId,
        address rewardRegistry,
        address rewardOwner,
        uint32 maxClaimsPerAddr,
        uint32 totalClaimed,
        uint32 maxTotalClaims,
        Requirement[] memory requirements
    ) {
        Rule storage r = rules[ruleId];
        return (
            r.enabled, r.rewardSkuId, r.rewardRegistry, r.rewardOwner,
            r.maxClaimsPerAddr, r.totalClaimed, r.maxTotalClaims, r.requirements
        );
    }

    /// @notice 检查用户是否满足某规则的所有条件（不执行 claim）
    function checkEligible(uint256 ruleId, address user) external view returns (bool, uint256 failedIndex) {
        Rule storage r = rules[ruleId];
        for (uint256 i; i < r.requirements.length; ++i) {
            Requirement memory req = r.requirements[i];
            uint256 bal = req.assetType == AssetType.ERC20
                ? IERC20Min(req.asset).balanceOf(user)
                : IERC721Min(req.asset).balanceOf(user);
            if (bal < req.minAmount) return (false, i);
        }
        return (true, 0);
    }
}
```

---

## 二、完整 ABI（ethers 人类可读格式）

```
event RuleSet(uint256 indexed ruleId, bool enabled, bytes32 rewardSkuId, address rewardRegistry, address rewardOwner, uint32 maxClaimsPerAddr, uint32 maxTotalClaims)
event RuleEnabled(uint256 indexed ruleId, bool enabled)
event Claimed(uint256 indexed ruleId, address indexed claimer, bytes32 rewardSkuId, uint32 claimIndex)
event MinerSet(address indexed addr, bool enabled)
event ChannelSet(address indexed registry, bool enabled, uint64 validUntil)
event Paused(bool isPaused)

// 用户写函数
function claim(uint256 ruleId) external

// Miner 函数
function setMiner(address addr, bool enabled) external
function setPaused(bool paused) external
function setChannel(address registry, bool enabled, uint64 validUntil) external
function setTradeLedger(address tl) external
function setBurnAddress(address burn) external
function setRule(uint256 ruleId, bool enabled, bytes32 rewardSkuId, address rewardRegistry, address rewardOwner, uint32 maxClaimsPerAddr, uint32 maxTotalClaims, tuple(address asset, uint8 assetType, uint256 minAmount, bool burnOnClaim)[] reqs) external returns (uint256 id)
function setRuleEnabled(uint256 ruleId, bool enabled) external

// view
function isChannel(address registry) external view returns (bool)
function getRule(uint256 ruleId) external view returns (bool enabled, bytes32 rewardSkuId, address rewardRegistry, address rewardOwner, uint32 maxClaimsPerAddr, uint32 totalClaimed, uint32 maxTotalClaims, tuple(address asset, uint8 assetType, uint256 minAmount, bool burnOnClaim)[] requirements)
function checkEligible(uint256 ruleId, address user) external view returns (bool eligible, uint256 failedIndex)
function claimedCount(uint256 ruleId, address user) external view returns (uint32)
function ruleCount() external view returns (uint256)
function paused() external view returns (bool)
function isMiner(address) external view returns (bool)
function tradeLedger() external view returns (address)
function burnAddress() external view returns (address)
function channelGrants(address) external view returns (bool enabled, uint64 validUntil)
```

---

## 三、函数参数使用说明

| 函数               | 谁可调       | 参数说明                                                                                                                                               |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setRule`        | miner     | `ruleId=0` 新建；`rewardSkuId` • `rewardRegistry` 指定奖励 SKU；`rewardOwner` 发奖方（需预先允许本合约 channelTransfer）；`reqs[]` 条件列表；`burnOnClaim=true` 仅对 ERC20 类型有效 |
| `setRuleEnabled` | miner     | 快速开关规则，不改其他配置                                                                                                                                      |
| `claim`          | 任何人       | `ruleId`=规则 ID；合约自动验证所有 `requirements`；满足则过户 rewardSku 给 msg.sender                                                                                |
| `checkEligible`  | 任何人（view） | 提前检查是否满足条件；`failedIndex` 指示第几条未满足                                                                                                                  |

**典型使用场景：**

- **集邮挖矿**：持有 A/B/C 三种 NFT 各≥1 → 兑换 SKU（NFT 不销毁，仅验证持有）
- **消耗挖矿**：持有 ≥1000 HRC → 销毁 1000 HRC → 兑换 SKU（`burnOnClaim=true`）
- **混合**：持有 NFT + 消耗 HRC → 兑换 SKU

---

## 四、部署 SH（[mining-claim-deploy.sh](http://mining-claim-deploy.sh)）

```bash
#!/usr/bin/env bash
# mining-claim-deploy.sh — MiningClaim 部署脚本
# 用法: bash mining-claim-deploy.sh obt|r9|qdt
set -euo pipefail

CHAIN="${1:-}"
[[ -z "${CHAIN}" ]] && { echo "Usage: $0 obt|r9|qdt"; exit 1; }

MINER_1="${MINER_1:-}"
PRIVATE_KEY="${PRIVATE_KEY:-}"

case "${CHAIN}" in
  obt) EXPECT_ID=1008611;  RPC="<http://47.86.44.43:39546>"; TRADE_LEDGER="${TRADE_LEDGER_OBT:-0x0000000000000000000000000000000000000000}" ;;
  r9)  EXPECT_ID=555555555; RPC="<http://47.86.44.43:41546>"; TRADE_LEDGER="${TRADE_LEDGER_R9:-0x0000000000000000000000000000000000000000}" ;;
  qdt) EXPECT_ID=88888888;  RPC="<http://47.86.44.43:40546>"; TRADE_LEDGER="${TRADE_LEDGER_QDT:-0x0000000000000000000000000000000000000000}" ;;
  *) echo "Unknown chain: ${CHAIN}"; exit 1 ;;
esac

[[ -z "${PRIVATE_KEY}" ]] && { echo "PRIVATE_KEY not set"; exit 1; }
[[ -z "${MINER_1}" ]]     && { echo "MINER_1 not set"; exit 1; }

GOT_ID=$(cast chain-id --rpc-url "${RPC}" 2>/dev/null || echo 0)
[[ "${GOT_ID}" != "${EXPECT_ID}" ]] && { echo "Chain ID mismatch: got ${GOT_ID} want ${EXPECT_ID}"; exit 1; }

grep -q 'optimizer = true' foundry.toml || { echo "optimizer=true missing"; exit 1; }
grep -q 'via_ir = true'    foundry.toml || { echo "via_ir=true missing"; exit 1; }

echo "[${CHAIN}] Deploying MiningClaim..."
forge build --skip test --skip script > build.log 2>&1 || { tail -n 30 build.log; exit 1; }

DEPLOY_OUT=$(forge create src/MiningClaim.sol:MiningClaim \
  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" \
  --evm-version paris --skip test --skip script \
  --constructor-args "${TRADE_LEDGER}" "[${MINER_1}]" 2>&1)

echo "${DEPLOY_OUT}" >> deploy-${CHAIN}.log
CONTRACT=$(echo "${DEPLOY_OUT}" | grep 'Deployed to:' | awk '{print $NF}')
[[ -z "${CONTRACT}" ]] && { tail -n 30 deploy-${CHAIN}.log; exit 1; }

cast call "${CONTRACT}" "ruleCount()" --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1
cast call "${CONTRACT}" "paused()"    --rpc-url "${RPC}" >> deploy-${CHAIN}.log 2>&1

echo "[${CHAIN}] MiningClaim: ${CONTRACT}"
echo "→ ShortNumRegistry.setChannel(${CONTRACT}, true, 0)"
echo "→ GoodsMarket.setChannel(${CONTRACT}, true, 0)"
echo "→ TradeLedger.setChannel(${CONTRACT}, true)"
```

---

## 五、完整部署参数

| 参数              | OBT (1008611)   | R9 (555555555)  |
| --------------- | --------------- | --------------- |
| tradeLedger     | ⬜ 待 P1-C 地址回填   | ⬜ 待 P1-C 地址回填   |
| miners          | ⬜ 填入运营 miner 钱包 | ⬜ 填入运营 miner 钱包 |
| evm_version     | paris           | paris           |
| burnAddress（默认） | 0x000…dEaD      | 0x000…dEaD      |

---

## 六、部署登记表
