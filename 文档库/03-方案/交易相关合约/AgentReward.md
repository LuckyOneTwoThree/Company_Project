# AgentReward.sol（购买触发级差制分账 · compression · 不持币）

<aside>  
💸

**定位**：购买触发的**返利分配引擎**。GoodsMarket 在一笔交易内调 `onPurchase(...)`；本合约沿 E 链（ReferralRegistry）上溯 N 层，**每层按该层上线自己的等级**取 `AgentLevel.rebateBps[rank][layer]`（级差制），compression 开时跳过未达标上线、名额上卷；逐层直写 `RewardClaim.addReward`。**本合约不持币**（只写额度，币在 RewardClaim 池里）。宪法参数以 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) 「一」为准。

</aside>

## 一、设计要点

- **触发**：`onPurchase(buyer, productId, grossPrice, netPrice, payToken, refId)`，仅 rewarder（GoodsMarket）可调。
- **基准**：`base = AgentLevel.basis()==1 ? netPrice : grossPrice`（默认原价 grossPrice）。
- **级差制**：沿 E 链取上线，第 `layer` 个合格上线获 `base * rebateBps[该上线自身 rank][layer] / 10000`。
- **compression（读 AgentLevel.compression）**：开→上线 `level=0`（未达标/未激活）则跳过、名额上卷给上面下一个合格上线；关→该层作废（浪费一个名额）。上卷步数由 `maxCompressionSkips` 硬限制（防 gas 爆炸）。
- **幂等**：`refId' = keccak256(abi.encode(orderRefId, layerIndex))`，每层每单唯一；同一订单 refId 不可重入。
- **多币路由**：`claimFor[payToken]` 指向对应单币 RewardClaim（其 token 必须等于 payToken）；返利与支付同币、精度一致。
- **安全护栏**：防自推（`cur != buyer`）、E 链为树无环 + guard 步数上限、`minRebate` 去尘、`maxRebatePerLayer` 单层封顶、`maxTotalPerOrder` 整单池封顶。
- **不持币**：只写 RewardClaim 额度；需 miner 在 RewardClaim `setRewarder(AgentReward, max)` 授权。
- **退货撤链**：`revokeOrder(refId)` 逐层 try/catch `RewardClaim.revokeReward`（已领取的层由 GoodsMarket 退货前置 `returnReward` 处理，这里自动跳过）。

## 二、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReferralRegistry {
    function referrerOf(address user) external view returns (address);
}
interface IAgentLevel {
    function levelOf(address a) external view returns (uint256);
    function getRebateBps(uint256 rank, uint256 layer) external view returns (uint256);
    function rebateLayers() external view returns (uint256);
    function basis() external view returns (uint8);
    function compression() external view returns (bool);
}
interface IRewardClaim {
    function addReward(address user, uint256 amount, bytes32 refId) external;
    function revokeReward(bytes32 refId) external;
}

/// @title AgentReward - purchase-triggered differential rebate distributor
/// @notice Holds no funds. Walks the E (referral) chain and writes per-layer
///         rebates into the matching single-token RewardClaim.
contract AgentReward {
    IReferralRegistry public registry;
    IAgentLevel public agentLevel;

    uint256 public constant MAX_MINERS = 3;
    mapping(address => bool) public isMiner;
    uint256 public minerCount;

    // rewarder (GoodsMarket) role window; miner always allowed
    mapping(address => uint256) public rewarderValidUntil;

    // payToken => RewardClaim (claim.token MUST equal payToken)
    mapping(address => address) public claimFor;

    // safety knobs
    uint256 public minRebate;            // skip dust below this
    uint256 public maxRebatePerLayer;    // 0 = no cap
    uint256 public maxTotalPerOrder;     // 0 = no cap
    uint256 public maxCompressionSkips = 20; // bound extra walk when compressing

    struct Order { address payToken; bool exists; }
    mapping(bytes32 => Order) public orders;          // orderRefId => Order
    mapping(bytes32 => bytes32[]) internal _orderRefIds; // orderRefId => layer refIds

    bool public paused;

    event MinerSet(address indexed miner, bool enabled, address indexed by);
    event PausedSet(bool paused, address indexed by);
    event RewarderSet(address indexed rewarder, uint256 validUntil, address indexed by);
    event RegistrySet(address indexed registry, address indexed by);
    event AgentLevelSet(address indexed agentLevel, address indexed by);
    event ClaimForSet(address indexed payToken, address indexed claim, address indexed by);
    event KnobsSet(uint256 minRebate, uint256 maxRebatePerLayer, uint256 maxTotalPerOrder, uint256 maxCompressionSkips, address indexed by);
    event RebatePaid(bytes32 indexed orderRefId, address indexed agent, uint256 layer, uint256 rank, uint256 amount);
    event PurchaseProcessed(bytes32 indexed orderRefId, address indexed buyer, uint256 totalPaid);
    event OrderRevoked(bytes32 indexed orderRefId, address indexed by);

    modifier onlyMiner() { require(isMiner[msg.sender], "AR: not miner"); _; }
    modifier onlyRewarder() { require(isRewarder(msg.sender), "AR: not rewarder"); _; }
    modifier whenNotPaused() { require(!paused, "AR: paused"); _; }

    constructor(address registry_, address agentLevel_, address[] memory miners_) {
        require(registry_ != address(0) && agentLevel_ != address(0), "AR: zero dep");
        registry = IReferralRegistry(registry_);
        agentLevel = IAgentLevel(agentLevel_);
        uint256 n = miners_.length;
        require(n > 0 && n <= MAX_MINERS, "AR: miners 1..3");
        for (uint256 i = 0; i < n; i++) {
            address m = miners_[i];
            require(m != address(0), "AR: zero miner");
            if (!isMiner[m]) { isMiner[m] = true; minerCount++; emit MinerSet(m, true, msg.sender); }
        }
    }

    function isRewarder(address a) public view returns (bool) {
        return isMiner[a] ||
            (rewarderValidUntil[a] != 0 && block.timestamp <= rewarderValidUntil[a]);
    }

    // ---------- core: purchase-triggered distribution ----------
    function onPurchase(
        address buyer,
        uint256 productId,
        uint256 grossPrice,
        uint256 netPrice,
        address payToken,
        bytes32 refId
    ) external onlyRewarder whenNotPaused {
        require(buyer != address(0), "AR: zero buyer");
        require(!orders[refId].exists, "AR: order used");
        address claim = claimFor[payToken];
        require(claim != address(0), "AR: no claim for token");
        orders[refId] = Order(payToken, true);
        productId; // kept for event/interface symmetry

        uint256 base = agentLevel.basis() == 1 ? netPrice : grossPrice;
        uint256 layers = agentLevel.rebateLayers();
        bool comp = agentLevel.compression();
        uint256 totalPaid = 0;

        if (base > 0 && layers > 0) {
            address cur = registry.referrerOf(buyer);
            uint256 filled = 0;
            uint256 guard = 0;
            uint256 maxWalk = layers + maxCompressionSkips;
            while (filled < layers && cur != address(0) && guard < maxWalk) {
                guard++;
                uint256 rank = agentLevel.levelOf(cur);
                if (rank == 0) {
                    // unqualified upline
                    if (comp) { cur = registry.referrerOf(cur); continue; } // roll up
                    filled++; cur = registry.referrerOf(cur); continue;     // waste layer
                }
                uint256 layerIndex = filled + 1;
                uint256 bps = agentLevel.getRebateBps(rank, layerIndex);
                if (bps > 0 && cur != buyer) {
                    uint256 amount = (base * bps) / 10000;
                    if (maxRebatePerLayer > 0 && amount > maxRebatePerLayer) amount = maxRebatePerLayer;
                    if (amount >= minRebate && amount > 0) {
                        bytes32 layerRefId = keccak256(abi.encode(refId, layerIndex));
                        IRewardClaim(claim).addReward(cur, amount, layerRefId);
                        _orderRefIds[refId].push(layerRefId);
                        totalPaid += amount;
                        emit RebatePaid(refId, cur, layerIndex, rank, amount);
                    }
                }
                filled++;
                cur = registry.referrerOf(cur);
            }
        }
        require(maxTotalPerOrder == 0 || totalPaid <= maxTotalPerOrder, "AR: over order cap");
        emit PurchaseProcessed(refId, buyer, totalPaid);
    }

    // ---------- revoke whole order (unclaimed layers) ----------
    function revokeOrder(bytes32 refId) external onlyRewarder {
        Order storage o = orders[refId];
        require(o.exists, "AR: no order");
        address claim = claimFor[o.payToken];
        bytes32[] storage ids = _orderRefIds[refId];
        for (uint256 i = 0; i < ids.length; i++) {
            try IRewardClaim(claim).revokeReward(ids[i]) {} catch {}
        }
        emit OrderRevoked(refId, msg.sender);
    }

    // ---------- preview (front-end transparency) ----------
    function previewRebate(address buyer, uint256 base)
        external view
        returns (address[] memory agents, uint256[] memory amounts, uint256[] memory ranks)
    {
        uint256 layers = agentLevel.rebateLayers();
        bool comp = agentLevel.compression();
        agents = new address[](layers);
        amounts = new uint256[](layers);
        ranks = new uint256[](layers);
        if (base == 0 || layers == 0) return (agents, amounts, ranks);
        address cur = registry.referrerOf(buyer);
        uint256 filled = 0;
        uint256 guard = 0;
        uint256 maxWalk = layers + maxCompressionSkips;
        while (filled < layers && cur != address(0) && guard < maxWalk) {
            guard++;
            uint256 rank = agentLevel.levelOf(cur);
            if (rank == 0) {
                if (comp) { cur = registry.referrerOf(cur); continue; }
                filled++; cur = registry.referrerOf(cur); continue;
            }
            uint256 layerIndex = filled + 1;
            uint256 bps = agentLevel.getRebateBps(rank, layerIndex);
            uint256 amount = (base * bps) / 10000;
            if (maxRebatePerLayer > 0 && amount > maxRebatePerLayer) amount = maxRebatePerLayer;
            agents[filled] = cur;
            amounts[filled] = amount;
            ranks[filled] = rank;
            filled++;
            cur = registry.referrerOf(cur);
        }
    }

    function orderRefIds(bytes32 refId) external view returns (bytes32[] memory) {
        return _orderRefIds[refId];
    }

    // ---------- config (miner) ----------
    function setRewarder(address rewarder, uint256 validUntil) external onlyMiner {
        require(rewarder != address(0), "AR: zero rewarder");
        rewarderValidUntil[rewarder] = validUntil;
        emit RewarderSet(rewarder, validUntil, msg.sender);
    }
    function setClaimFor(address payToken, address claim) external onlyMiner {
        require(payToken != address(0), "AR: zero token");
        claimFor[payToken] = claim; // 0 to unset
        emit ClaimForSet(payToken, claim, msg.sender);
    }
    function setKnobs(uint256 minRebate_, uint256 maxRebatePerLayer_, uint256 maxTotalPerOrder_, uint256 maxCompressionSkips_) external onlyMiner {
        require(maxCompressionSkips_ <= 100, "AR: skips too high");
        minRebate = minRebate_;
        maxRebatePerLayer = maxRebatePerLayer_;
        maxTotalPerOrder = maxTotalPerOrder_;
        maxCompressionSkips = maxCompressionSkips_;
        emit KnobsSet(minRebate_, maxRebatePerLayer_, maxTotalPerOrder_, maxCompressionSkips_, msg.sender);
    }
    function setRegistry(address r) external onlyMiner {
        require(r != address(0), "AR: zero");
        registry = IReferralRegistry(r);
        emit RegistrySet(r, msg.sender);
    }
    function setAgentLevel(address a) external onlyMiner {
        require(a != address(0), "AR: zero");
        agentLevel = IAgentLevel(a);
        emit AgentLevelSet(a, msg.sender);
    }
    function setMiner(address miner, bool enabled) external onlyMiner {
        require(miner != address(0), "AR: zero miner");
        if (enabled) {
            require(!isMiner[miner], "AR: already miner");
            require(minerCount < MAX_MINERS, "AR: max miners");
            isMiner[miner] = true; minerCount++;
        } else {
            require(isMiner[miner], "AR: not miner");
            require(minerCount > 1, "AR: need >=1 miner");
            isMiner[miner] = false; minerCount--;
        }
        emit MinerSet(miner, enabled, msg.sender);
    }
    function setPaused(bool p) external onlyMiner {
        paused = p;
        emit PausedSet(p, msg.sender);
    }
}
```

## 三、完整 ABI

### 3.1 ethers 人类可读

```jsx
const AGENTREWARD_ABI = [
  "constructor(address registry_, address agentLevel_, address[] miners_)",
  // reads
  "function registry() view returns (address)",
  "function agentLevel() view returns (address)",
  "function MAX_MINERS() view returns (uint256)",
  "function isMiner(address) view returns (bool)",
  "function minerCount() view returns (uint256)",
  "function rewarderValidUntil(address) view returns (uint256)",
  "function isRewarder(address a) view returns (bool)",
  "function claimFor(address) view returns (address)",
  "function minRebate() view returns (uint256)",
  "function maxRebatePerLayer() view returns (uint256)",
  "function maxTotalPerOrder() view returns (uint256)",
  "function maxCompressionSkips() view returns (uint256)",
  "function orders(bytes32) view returns (address payToken, bool exists)",
  "function orderRefIds(bytes32 refId) view returns (bytes32[])",
  "function paused() view returns (bool)",
  "function previewRebate(address buyer, uint256 base) view returns (address[] agents, uint256[] amounts, uint256[] ranks)",
  // writes
  "function onPurchase(address buyer, uint256 productId, uint256 grossPrice, uint256 netPrice, address payToken, bytes32 refId)",
  "function revokeOrder(bytes32 refId)",
  "function setRewarder(address rewarder, uint256 validUntil)",
  "function setClaimFor(address payToken, address claim)",
  "function setKnobs(uint256 minRebate_, uint256 maxRebatePerLayer_, uint256 maxTotalPerOrder_, uint256 maxCompressionSkips_)",
  "function setRegistry(address r)",
  "function setAgentLevel(address a)",
  "function setMiner(address miner, bool enabled)",
  "function setPaused(bool p)",
  // events
  "event MinerSet(address indexed miner, bool enabled, address indexed by)",
  "event PausedSet(bool paused, address indexed by)",
  "event RewarderSet(address indexed rewarder, uint256 validUntil, address indexed by)",
  "event RegistrySet(address indexed registry, address indexed by)",
  "event AgentLevelSet(address indexed agentLevel, address indexed by)",
  "event ClaimForSet(address indexed payToken, address indexed claim, address indexed by)",
  "event KnobsSet(uint256 minRebate, uint256 maxRebatePerLayer, uint256 maxTotalPerOrder, uint256 maxCompressionSkips, address indexed by)",
  "event RebatePaid(bytes32 indexed orderRefId, address indexed agent, uint256 layer, uint256 rank, uint256 amount)",
  "event PurchaseProcessed(bytes32 indexed orderRefId, address indexed buyer, uint256 totalPaid)",
  "event OrderRevoked(bytes32 indexed orderRefId, address indexed by)"
];
```

### 3.2 JSON ABI（核心条目）

```json
[
  {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"registry_","type":"address"},{"name":"agentLevel_","type":"address"},{"name":"miners_","type":"address[]"}]},
  {"type":"function","name":"onPurchase","stateMutability":"nonpayable","inputs":[{"name":"buyer","type":"address"},{"name":"productId","type":"uint256"},{"name":"grossPrice","type":"uint256"},{"name":"netPrice","type":"uint256"},{"name":"payToken","type":"address"},{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"revokeOrder","stateMutability":"nonpayable","inputs":[{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"previewRebate","stateMutability":"view","inputs":[{"name":"buyer","type":"address"},{"name":"base","type":"uint256"}],"outputs":[{"name":"agents","type":"address[]"},{"name":"amounts","type":"uint256[]"},{"name":"ranks","type":"uint256[]"}]},
  {"type":"function","name":"orders","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"name":"payToken","type":"address"},{"name":"exists","type":"bool"}]},
  {"type":"function","name":"orderRefIds","stateMutability":"view","inputs":[{"name":"refId","type":"bytes32"}],"outputs":[{"type":"bytes32[]"}]},
  {"type":"function","name":"claimFor","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"address"}]},
  {"type":"function","name":"isRewarder","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"setRewarder","stateMutability":"nonpayable","inputs":[{"name":"rewarder","type":"address"},{"name":"validUntil","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setClaimFor","stateMutability":"nonpayable","inputs":[{"name":"payToken","type":"address"},{"name":"claim","type":"address"}],"outputs":[]},
  {"type":"function","name":"setKnobs","stateMutability":"nonpayable","inputs":[{"name":"minRebate_","type":"uint256"},{"name":"maxRebatePerLayer_","type":"uint256"},{"name":"maxTotalPerOrder_","type":"uint256"},{"name":"maxCompressionSkips_","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setRegistry","stateMutability":"nonpayable","inputs":[{"name":"r","type":"address"}],"outputs":[]},
  {"type":"function","name":"setAgentLevel","stateMutability":"nonpayable","inputs":[{"name":"a","type":"address"}],"outputs":[]},
  {"type":"function","name":"setMiner","stateMutability":"nonpayable","inputs":[{"name":"miner","type":"address"},{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setPaused","stateMutability":"nonpayable","inputs":[{"name":"p","type":"bool"}],"outputs":[]},
  {"type":"event","name":"RebatePaid","anonymous":false,"inputs":[{"name":"orderRefId","type":"bytes32","indexed":true},{"name":"agent","type":"address","indexed":true},{"name":"layer","type":"uint256","indexed":false},{"name":"rank","type":"uint256","indexed":false},{"name":"amount","type":"uint256","indexed":false}]},
  {"type":"event","name":"PurchaseProcessed","anonymous":false,"inputs":[{"name":"orderRefId","type":"bytes32","indexed":true},{"name":"buyer","type":"address","indexed":true},{"name":"totalPaid","type":"uint256","indexed":false}]},
  {"type":"event","name":"OrderRevoked","anonymous":false,"inputs":[{"name":"orderRefId","type":"bytes32","indexed":true},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"ClaimForSet","anonymous":false,"inputs":[{"name":"payToken","type":"address","indexed":true},{"name":"claim","type":"address","indexed":true},{"name":"by","type":"address","indexed":true}]}
]
```

> 完整 JSON ABI 由 `forge inspect AgentReward abi` 生成；上表列出 GoodsMarket / 前端最常用条目。

## 四、函数参数使用说明

| 函数                                                                              | 谁可调                          | 参数                                                 | 说明 / 示例                                         |
| ------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `onPurchase(buyer, productId, grossPrice, netPrice, payToken, refId)`           | rewarder（GoodsMarket）或 miner | buyer=买家；gross=原价；net=成交价；payToken=支付币；refId=订单幂等键 | 购买同交易内触发；沿 E 链级差制分账、直写 `claimFor[payToken]`     |
| `revokeOrder(refId)`                                                            | rewarder 或 miner             | refId=订单号                                          | 逐层 try/catch 撤销未领取返利；已领的自动跳过（由 returnReward 处理） |
| `previewRebate(buyer, base)`                                                    | 任何人（view）                    | buyer；base=按基准价                                    | 前端预览每层 agent/金额/rank，透明展示                       |
| `setRewarder(rewarder, validUntil)`                                             | 仅 miner                      | rewarder=GoodsMarket；validUntil（max/0）             | 授权谁能触发 onPurchase                               |
| `setClaimFor(payToken, claim)`                                                  | 仅 miner                      | payToken；claim=对应单币 RewardClaim（token 必须=payToken） | 多币路由；`0` 取消映射                                   |
| `setKnobs(minRebate, maxRebatePerLayer, maxTotalPerOrder, maxCompressionSkips)` | 仅 miner                      | 四个护栏（均 0=不限，skips≤10≤100）                          | 去尘 / 单层封顶 / 整单池封顶 / 压缩上卷步数上限                    |
| `setRegistry / setAgentLevel / setMiner / setPaused`                            | 仅 miner                      | 见 ABI                                              | 常规运维                                            |

> **refId 约定**：订单 `refId`（与 GoodsMarket 同一）= `keccak256(abi.encode(chainId, sku, orderId))`；每层返利 refId' = `keccak256(abi.encode(refId, layerIndex))`，与 RewardClaim 幂等键一致，可精准撤销。

## 五、SH 部署脚本（[agentreward-deploy.sh](http://agentreward-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail

# ===== AgentReward 部署（防串链）=====
# 用法: PRIVATE_KEY=0x.. REGISTRY=0x.. AGENTLEVEL=0x.. ./agentreward-deploy.sh [r9|obt|qdt]
CHAIN_KEY="${1:-r9}"

case "${CHAIN_KEY}" in
  r9)  RPC="${RPC:-<http://47.86.44.43:41546>}"; EXPECT_CHAINID=555555555 ;;
  obt) RPC="${RPC:-<http://47.86.44.43:39546>}"; EXPECT_CHAINID=1008611 ;;
  qdt) RPC="${RPC:-<http://47.86.44.43:40546>}"; EXPECT_CHAINID=88888888 ;;
  *) echo "unknown chainKey: ${CHAIN_KEY}"; exit 1 ;;
esac

: "${PRIVATE_KEY:?need PRIVATE_KEY}"
: "${REGISTRY:?need REGISTRY (ReferralRegistry 地址)}"
: "${AGENTLEVEL:?need AGENTLEVEL (AgentLevel 地址)}"
DEPLOYER="${DEPLOYER:-0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996}"
MINERS="${MINERS:-${DEPLOYER}}"
MINERS_ARR="[$(echo "${MINERS}" | tr -d ' ')]"

# ---- 防串链 + 依赖校验 ----
ACTUAL_CHAINID="$(cast chain-id --rpc-url "${RPC}")"
[ "${ACTUAL_CHAINID}" = "${EXPECT_CHAINID}" ] || { echo "❌ chainId 不符: 期望 ${EXPECT_CHAINID}, 实测 ${ACTUAL_CHAINID}"; exit 1; }
for DEP in "${REGISTRY}" "${AGENTLEVEL}"; do
  [ "$(cast code "${DEP}" --rpc-url "${RPC}")" != "0x" ] || { echo "❌ 依赖 ${DEP} 非合约"; exit 1; }
done
echo "✅ chainId ${ACTUAL_CHAINID}; deps ok"

ADDR="$(forge create \
  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" \
  --evm-version shanghai --optimize --optimizer-runs 200 --legacy \
  src/AgentReward.sol:AgentReward \
  --constructor-args "${REGISTRY}" "${AGENTLEVEL}" "${MINERS_ARR}" \
  | grep 'Deployed to:' | awk '{print $3}')"
echo "AgentReward deployed: ${ADDR}"

# ---- 自检 ----
echo "registry   = $(cast call "${ADDR}" 'registry()(address)' --rpc-url "${RPC}")"
echo "agentLevel = $(cast call "${ADDR}" 'agentLevel()(address)' --rpc-url "${RPC}")"
echo "minerCount = $(cast call "${ADDR}" 'minerCount()(uint256)' --rpc-url "${RPC}")"

echo "AGENTREWARD_${CHAIN_KEY}=${ADDR}" >> deploy.out
# 部署后（关键回填）：
# 1) 本合约：setClaimFor(HRC, REWARDCLAIM_HRC)、setClaimFor(USDR, REWARDCLAIM_USDR) …
# 2) 本合约：setRewarder(GoodsMarket, max)
# 3) 每个 RewardClaim：setRewarder(AgentReward, max)（在 RewardClaim 上授权）
# 4) 可选：setKnobs(minRebate, maxPerLayer, maxPerOrder, maxSkips)
```

## 六、完整部署参数

| 参数                     | 值 / 来源                                                                                                                                    | 说明                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| solidity / evm_version | `^0.8.24` / `shanghai`                                                                                                                    | 统一                             |
| 构造 `registry_`         | ReferralRegistry(E)，见 [Aeon R9 · 冷钱包上下级永久绑定：合约设计与 App/后端实施](https://app.notion.com/p/Aeon-R9-App-15a2b77e1e3e41a58b1876d5552fb079?pvs=21) | 上线链来源                          |
| 构造 `agentLevel_`       | AgentLevel 部署地址（本体系第 3 份）                                                                                                                 | 等级 + 返利表来源                     |
| 构造 `miners_`           | `[0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996]`                                                                                            | 上限 3                           |
| 回填 1                   | `setClaimFor(payToken, RewardClaim)` 逐币                                                                                                   | token 必须与 RewardClaim.token 一致 |
| 回填 2                   | 本合约 `setRewarder(GoodsMarket, max)`                                                                                                       | 允许 GoodsMarket 触发              |
| 回填 3                   | 在每个 RewardClaim 上 `setRewarder(AgentReward, max)`                                                                                         | 允许直写额度                         |

<aside>  
🔗

**回填位**：`AGENTREWARD_R9 = 0x____`。地址写回 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) F 宪法登记 + 本体系总纲；GoodsMarket 构造/回填需要此地址。

</aside>

## 七、r9-admin 挂载要点

- 新增类型 **AgentReward**（分类 tab：中文「代理返利」+ 英文小字 AgentReward）。
- 详情（read）：`registry/agentLevel/minRebate/maxRebatePerLayer/maxTotalPerOrder/maxCompressionSkips`；按 payToken 查 `claimFor`；按 refId 查 `orders` + `orderRefIds`；`previewRebate(buyer, base)` 预览。
- Miner 面板：`setRewarder`、`setClaimFor`、`setKnobs`、`revokeOrder`、`setRegistry/setAgentLevel`、`setMiner/setPaused`。
- 全局 `_arAddr` 变量避免 onclick 嵌套引号。
