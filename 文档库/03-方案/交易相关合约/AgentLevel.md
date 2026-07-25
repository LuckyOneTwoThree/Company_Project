# AgentLevel.sol（代理等级 1..10 · 级差制返利表 · compression）

<aside>  
🏅

**定位**：代理「等级」权威源。每个钱包地址一个等级 `level ∈ 1..10`（0=非代理/无返利资格），**各自靠自身达标独立升级**——A 是 L10 不会抬高其上线的等级（普众公平）。升级燃料来自 AgentPoints（个人积分）或团队累积积分 `teamPoints`，达标后经 miner 审核升级。本合约同时持有**级差制返利表** `rebateBps[rank][layer]`、返利层数 `rebateLayers`、计价基准 `basis`、动态压缩开关 `compression`，供 AgentReward 读取分账。宪法参数以 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) 「一」为准。

</aside>

## 一、两个维度别混（定案）

<aside>  
🧭

- **等级 rank = 横向**：以自己为起点的「团队级别」L1..10，逐级叠加权益；每个代理靠自身达标独立升级。
- **层级 layer/depth = 纵向**：单个订单里沿上线链的深度位（+1/+2/+3…）。
- **派发 = 级差制**：每层返利按**该层上线自己的等级**取 `rebateBps[rank][layer]`，不受下游等级影响。
- **compression（默认开、可关）**：某层上线未达标/未激活（level=0）则跳过，名额上卷给上面下一个合格上线，避免名额浪费、强化升级动力。  
  
  </aside>

## 二、设计要点

- **等级**：`level[addr] ∈ 0..10`；`levelOf/isQualified` 供 AgentReward 读取。
- **升级燃料两种基准**（每级可分别配置）：`thresholdBasis[level]`：`0`=个人积分（读 AgentPoints.balanceOf）、`1`=团队积分（`teamPoints[addr]`）。
- **团队积分累加**：`teamPoints` 由授权 `feeder`（GoodsMarket / 专用喂价器，validUntil 时窗）通过 `recordPoints(member, amount)` 沿 E 链上溯 `teamDepth` 层逐个累加（含本人），避免链上向下枚举，天然 O(depth)。
- **升级流程**：用户 `requestUpgrade(targetLevel)` 入队并快照 metric → miner `approveUpgrade(id, enforceThreshold)`（可选强制校验门槛）落等级；miner 也可 `minerSetLevel` 直接设定（购买级别服务商品审核 / 手动补录）；`rejectUpgrade` 驳回。
- **返利表（级差制矩阵）**：`rebateBps[rank][layer]`，rank 1..10 × layer 1..`rebateLayers`；建议高 rank 行 ≥ 低 rank 行（叠加更多权益）；单元上限 10000 bps=100%。
- **返利层数**：`rebateLayers` 默认 3，硬上限 `MAX_REBATE_LAYERS=10`（gas 护栏）。
- **计价基准**：`basis`：`0`=原价（gross，默认）、`1`=成交价（net）。
- **多 miner**：`MAX_MINERS=3`。

> 你的例子（L1：+1 层 15% / +2 层 8% / +3 层 2%）即 `rebateBps[1] = [1500, 800, 200]`；更高等级配更高的行。

## 三、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoints {
    function balanceOf(address account) external view returns (uint256);
}
interface IReferralRegistry {
    function referrerOf(address user) external view returns (address);
}

/// @title AgentLevel - agent rank registry + differential rebate config
contract AgentLevel {
    IAgentPoints public agentPoints;
    IReferralRegistry public registry;

    uint256 public constant MAX_LEVEL = 10;
    uint256 public constant MAX_REBATE_LAYERS = 10;
    uint256 public constant MAX_MINERS = 3;

    mapping(address => bool) public isMiner;
    uint256 public minerCount;

    // agent rank 1..10 (0 = not an agent / no rebate)
    mapping(address => uint256) public level;

    // team points accumulator (incl. self), fed by feeder along E chain
    mapping(address => uint256) public teamPoints;
    mapping(address => uint256) public feederValidUntil; // feeder role window
    uint256 public teamDepth = 10; // ancestors to bump (incl. self)

    // upgrade thresholds: threshold[level] with basis 0=personal / 1=team
    mapping(uint256 => uint256) public threshold;
    mapping(uint256 => uint8) public thresholdBasis;

    // rebate config
    uint256 public rebateLayers = 3;
    uint8 public basis = 0;         // 0 = gross(原价), 1 = net(成交价)
    bool public compression = true; // roll-up unqualified uplines
    mapping(uint256 => mapping(uint256 => uint256)) public rebateBps; // [rank][layer]

    struct UpgradeRequest {
        address user;
        uint256 targetLevel;
        uint256 metricSnapshot;
        uint8 basisSnapshot;
        bool open;
    }
    UpgradeRequest[] public upgradeRequests;

    bool public paused;

    event MinerSet(address indexed miner, bool enabled, address indexed by);
    event PausedSet(bool paused, address indexed by);
    event AgentPointsSet(address indexed agentPoints, address indexed by);
    event RegistrySet(address indexed registry, address indexed by);
    event FeederSet(address indexed feeder, uint256 validUntil, address indexed by);
    event TeamDepthSet(uint256 depth, address indexed by);
    event PointsRecorded(address indexed member, uint256 amount, address indexed by);
    event ThresholdSet(uint256 indexed level, uint256 amount, uint8 basis, address indexed by);
    event RebateLayersSet(uint256 layers, address indexed by);
    event BasisSet(uint8 basis, address indexed by);
    event CompressionSet(bool compression, address indexed by);
    event RebateBpsSet(uint256 indexed rank, uint256 indexed layer, uint256 bps, address indexed by);
    event UpgradeRequested(uint256 indexed id, address indexed user, uint256 targetLevel, uint256 metric, uint8 basis);
    event UpgradeApproved(uint256 indexed id, address indexed user, uint256 level, address indexed by);
    event UpgradeRejected(uint256 indexed id, address indexed user, address indexed by);
    event LevelSet(address indexed user, uint256 level, address indexed by);

    modifier onlyMiner() { require(isMiner[msg.sender], "AL: not miner"); _; }
    modifier whenNotPaused() { require(!paused, "AL: paused"); _; }

    constructor(address agentPoints_, address registry_, address[] memory miners_) {
        require(agentPoints_ != address(0) && registry_ != address(0), "AL: zero dep");
        agentPoints = IAgentPoints(agentPoints_);
        registry = IReferralRegistry(registry_);
        uint256 n = miners_.length;
        require(n > 0 && n <= MAX_MINERS, "AL: miners 1..3");
        for (uint256 i = 0; i < n; i++) {
            address m = miners_[i];
            require(m != address(0), "AL: zero miner");
            if (!isMiner[m]) { isMiner[m] = true; minerCount++; emit MinerSet(m, true, msg.sender); }
        }
    }

    function isFeeder(address a) public view returns (bool) {
        return isMiner[a] ||
            (feederValidUntil[a] != 0 && block.timestamp <= feederValidUntil[a]);
    }

    // ---------- team points (feeder) ----------
    function recordPoints(address member, uint256 amount) external {
        require(isFeeder(msg.sender), "AL: not feeder");
        require(member != address(0) && amount > 0, "AL: bad args");
        address cur = member;
        uint256 d = teamDepth;
        for (uint256 i = 0; i < d; i++) {
            if (cur == address(0)) break;
            teamPoints[cur] += amount;
            cur = registry.referrerOf(cur);
        }
        emit PointsRecorded(member, amount, msg.sender);
    }

    // ---------- upgrade flow ----------
    function requestUpgrade(uint256 targetLevel) external whenNotPaused returns (uint256 id) {
        require(targetLevel > level[msg.sender] && targetLevel <= MAX_LEVEL, "AL: bad target");
        uint8 b = thresholdBasis[targetLevel];
        uint256 metric = b == 1 ? teamPoints[msg.sender] : agentPoints.balanceOf(msg.sender);
        id = upgradeRequests.length;
        upgradeRequests.push(UpgradeRequest(msg.sender, targetLevel, metric, b, true));
        emit UpgradeRequested(id, msg.sender, targetLevel, metric, b);
    }

    function approveUpgrade(uint256 id, bool enforceThreshold) external onlyMiner {
        UpgradeRequest storage r = upgradeRequests[id];
        require(r.open, "AL: closed");
        if (enforceThreshold) {
            uint256 metric = r.basisSnapshot == 1
                ? teamPoints[r.user]
                : agentPoints.balanceOf(r.user);
            require(metric >= threshold[r.targetLevel], "AL: below threshold");
        }
        r.open = false;
        level[r.user] = r.targetLevel;
        emit UpgradeApproved(id, r.user, r.targetLevel, msg.sender);
    }

    function rejectUpgrade(uint256 id) external onlyMiner {
        UpgradeRequest storage r = upgradeRequests[id];
        require(r.open, "AL: closed");
        r.open = false;
        emit UpgradeRejected(id, r.user, msg.sender);
    }

    function minerSetLevel(address user, uint256 newLevel) external onlyMiner {
        require(newLevel <= MAX_LEVEL, "AL: bad level");
        level[user] = newLevel;
        emit LevelSet(user, newLevel, msg.sender);
    }

    // ---------- config (miner) ----------
    function setThreshold(uint256 lvl, uint256 amount, uint8 basis_) external onlyMiner {
        require(lvl >= 1 && lvl <= MAX_LEVEL, "AL: bad level");
        require(basis_ <= 1, "AL: bad basis");
        threshold[lvl] = amount;
        thresholdBasis[lvl] = basis_;
        emit ThresholdSet(lvl, amount, basis_, msg.sender);
    }
    function setRebateLayers(uint256 n) external onlyMiner {
        require(n >= 1 && n <= MAX_REBATE_LAYERS, "AL: bad layers");
        rebateLayers = n;
        emit RebateLayersSet(n, msg.sender);
    }
    function setBasis(uint8 b) external onlyMiner {
        require(b <= 1, "AL: bad basis");
        basis = b;
        emit BasisSet(b, msg.sender);
    }
    function setCompression(bool c) external onlyMiner {
        compression = c;
        emit CompressionSet(c, msg.sender);
    }
    function setRebateBps(uint256 rank, uint256 layer, uint256 bps) external onlyMiner {
        require(rank >= 1 && rank <= MAX_LEVEL, "AL: bad rank");
        require(layer >= 1 && layer <= MAX_REBATE_LAYERS, "AL: bad layer");
        require(bps <= 10000, "AL: bps>100%");
        rebateBps[rank][layer] = bps;
        emit RebateBpsSet(rank, layer, bps, msg.sender);
    }
    function setRebateBpsBatch(uint256 rank, uint256[] calldata bpsPerLayer) external onlyMiner {
        require(rank >= 1 && rank <= MAX_LEVEL, "AL: bad rank");
        uint256 n = bpsPerLayer.length;
        require(n <= MAX_REBATE_LAYERS, "AL: too many");
        for (uint256 i = 0; i < n; i++) {
            require(bpsPerLayer[i] <= 10000, "AL: bps>100%");
            rebateBps[rank][i + 1] = bpsPerLayer[i];
            emit RebateBpsSet(rank, i + 1, bpsPerLayer[i], msg.sender);
        }
    }
    function setTeamDepth(uint256 d) external onlyMiner {
        require(d >= 1 && d <= 50, "AL: bad depth");
        teamDepth = d;
        emit TeamDepthSet(d, msg.sender);
    }
    function setFeeder(address f, uint256 validUntil) external onlyMiner {
        require(f != address(0), "AL: zero feeder");
        feederValidUntil[f] = validUntil;
        emit FeederSet(f, validUntil, msg.sender);
    }
    function setAgentPoints(address a) external onlyMiner {
        require(a != address(0), "AL: zero");
        agentPoints = IAgentPoints(a);
        emit AgentPointsSet(a, msg.sender);
    }
    function setRegistry(address r) external onlyMiner {
        require(r != address(0), "AL: zero");
        registry = IReferralRegistry(r);
        emit RegistrySet(r, msg.sender);
    }
    function setMiner(address miner, bool enabled) external onlyMiner {
        require(miner != address(0), "AL: zero miner");
        if (enabled) {
            require(!isMiner[miner], "AL: already miner");
            require(minerCount < MAX_MINERS, "AL: max miners");
            isMiner[miner] = true; minerCount++;
        } else {
            require(isMiner[miner], "AL: not miner");
            require(minerCount > 1, "AL: need >=1 miner");
            isMiner[miner] = false; minerCount--;
        }
        emit MinerSet(miner, enabled, msg.sender);
    }
    function setPaused(bool p) external onlyMiner {
        paused = p;
        emit PausedSet(p, msg.sender);
    }

    // ---------- views for AgentReward ----------
    function levelOf(address a) external view returns (uint256) { return level[a]; }
    function isQualified(address a) external view returns (bool) { return level[a] >= 1; }
    function getRebateBps(uint256 rank, uint256 layer) external view returns (uint256) {
        return rebateBps[rank][layer];
    }
    function upgradeRequestCount() external view returns (uint256) { return upgradeRequests.length; }
}
```

## 四、完整 ABI

### 4.1 ethers 人类可读

```jsx
const AGENTLEVEL_ABI = [
  "constructor(address agentPoints_, address registry_, address[] miners_)",
  // reads
  "function agentPoints() view returns (address)",
  "function registry() view returns (address)",
  "function MAX_LEVEL() view returns (uint256)",
  "function MAX_REBATE_LAYERS() view returns (uint256)",
  "function MAX_MINERS() view returns (uint256)",
  "function isMiner(address) view returns (bool)",
  "function minerCount() view returns (uint256)",
  "function level(address) view returns (uint256)",
  "function levelOf(address a) view returns (uint256)",
  "function isQualified(address a) view returns (bool)",
  "function teamPoints(address) view returns (uint256)",
  "function feederValidUntil(address) view returns (uint256)",
  "function isFeeder(address a) view returns (bool)",
  "function teamDepth() view returns (uint256)",
  "function threshold(uint256) view returns (uint256)",
  "function thresholdBasis(uint256) view returns (uint8)",
  "function rebateLayers() view returns (uint256)",
  "function basis() view returns (uint8)",
  "function compression() view returns (bool)",
  "function rebateBps(uint256 rank, uint256 layer) view returns (uint256)",
  "function getRebateBps(uint256 rank, uint256 layer) view returns (uint256)",
  "function upgradeRequests(uint256) view returns (address user, uint256 targetLevel, uint256 metricSnapshot, uint8 basisSnapshot, bool open)",
  "function upgradeRequestCount() view returns (uint256)",
  "function paused() view returns (bool)",
  // writes
  "function recordPoints(address member, uint256 amount)",
  "function requestUpgrade(uint256 targetLevel) returns (uint256 id)",
  "function approveUpgrade(uint256 id, bool enforceThreshold)",
  "function rejectUpgrade(uint256 id)",
  "function minerSetLevel(address user, uint256 newLevel)",
  "function setThreshold(uint256 lvl, uint256 amount, uint8 basis_)",
  "function setRebateLayers(uint256 n)",
  "function setBasis(uint8 b)",
  "function setCompression(bool c)",
  "function setRebateBps(uint256 rank, uint256 layer, uint256 bps)",
  "function setRebateBpsBatch(uint256 rank, uint256[] bpsPerLayer)",
  "function setTeamDepth(uint256 d)",
  "function setFeeder(address f, uint256 validUntil)",
  "function setAgentPoints(address a)",
  "function setRegistry(address r)",
  "function setMiner(address miner, bool enabled)",
  "function setPaused(bool p)",
  // events
  "event MinerSet(address indexed miner, bool enabled, address indexed by)",
  "event PausedSet(bool paused, address indexed by)",
  "event AgentPointsSet(address indexed agentPoints, address indexed by)",
  "event RegistrySet(address indexed registry, address indexed by)",
  "event FeederSet(address indexed feeder, uint256 validUntil, address indexed by)",
  "event TeamDepthSet(uint256 depth, address indexed by)",
  "event PointsRecorded(address indexed member, uint256 amount, address indexed by)",
  "event ThresholdSet(uint256 indexed level, uint256 amount, uint8 basis, address indexed by)",
  "event RebateLayersSet(uint256 layers, address indexed by)",
  "event BasisSet(uint8 basis, address indexed by)",
  "event CompressionSet(bool compression, address indexed by)",
  "event RebateBpsSet(uint256 indexed rank, uint256 indexed layer, uint256 bps, address indexed by)",
  "event UpgradeRequested(uint256 indexed id, address indexed user, uint256 targetLevel, uint256 metric, uint8 basis)",
  "event UpgradeApproved(uint256 indexed id, address indexed user, uint256 level, address indexed by)",
  "event UpgradeRejected(uint256 indexed id, address indexed user, address indexed by)",
  "event LevelSet(address indexed user, uint256 level, address indexed by)"
];
```

### 4.2 JSON ABI（核心条目）

```json
[
  {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"agentPoints_","type":"address"},{"name":"registry_","type":"address"},{"name":"miners_","type":"address[]"}]},
  {"type":"function","name":"levelOf","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"isQualified","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"getRebateBps","stateMutability":"view","inputs":[{"name":"rank","type":"uint256"},{"name":"layer","type":"uint256"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"rebateLayers","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"basis","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
  {"type":"function","name":"compression","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"teamPoints","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"recordPoints","stateMutability":"nonpayable","inputs":[{"name":"member","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"requestUpgrade","stateMutability":"nonpayable","inputs":[{"name":"targetLevel","type":"uint256"}],"outputs":[{"name":"id","type":"uint256"}]},
  {"type":"function","name":"approveUpgrade","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},{"name":"enforceThreshold","type":"bool"}],"outputs":[]},
  {"type":"function","name":"rejectUpgrade","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"minerSetLevel","stateMutability":"nonpayable","inputs":[{"name":"user","type":"address"},{"name":"newLevel","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setThreshold","stateMutability":"nonpayable","inputs":[{"name":"lvl","type":"uint256"},{"name":"amount","type":"uint256"},{"name":"basis_","type":"uint8"}],"outputs":[]},
  {"type":"function","name":"setRebateBps","stateMutability":"nonpayable","inputs":[{"name":"rank","type":"uint256"},{"name":"layer","type":"uint256"},{"name":"bps","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setRebateBpsBatch","stateMutability":"nonpayable","inputs":[{"name":"rank","type":"uint256"},{"name":"bpsPerLayer","type":"uint256[]"}],"outputs":[]},
  {"type":"function","name":"setRebateLayers","stateMutability":"nonpayable","inputs":[{"name":"n","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setBasis","stateMutability":"nonpayable","inputs":[{"name":"b","type":"uint8"}],"outputs":[]},
  {"type":"function","name":"setCompression","stateMutability":"nonpayable","inputs":[{"name":"c","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setFeeder","stateMutability":"nonpayable","inputs":[{"name":"f","type":"address"},{"name":"validUntil","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setTeamDepth","stateMutability":"nonpayable","inputs":[{"name":"d","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setAgentPoints","stateMutability":"nonpayable","inputs":[{"name":"a","type":"address"}],"outputs":[]},
  {"type":"function","name":"setRegistry","stateMutability":"nonpayable","inputs":[{"name":"r","type":"address"}],"outputs":[]},
  {"type":"function","name":"setMiner","stateMutability":"nonpayable","inputs":[{"name":"miner","type":"address"},{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setPaused","stateMutability":"nonpayable","inputs":[{"name":"p","type":"bool"}],"outputs":[]},
  {"type":"event","name":"RebateBpsSet","anonymous":false,"inputs":[{"name":"rank","type":"uint256","indexed":true},{"name":"layer","type":"uint256","indexed":true},{"name":"bps","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"UpgradeRequested","anonymous":false,"inputs":[{"name":"id","type":"uint256","indexed":true},{"name":"user","type":"address","indexed":true},{"name":"targetLevel","type":"uint256","indexed":false},{"name":"metric","type":"uint256","indexed":false},{"name":"basis","type":"uint8","indexed":false}]},
  {"type":"event","name":"UpgradeApproved","anonymous":false,"inputs":[{"name":"id","type":"uint256","indexed":true},{"name":"user","type":"address","indexed":true},{"name":"level","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"LevelSet","anonymous":false,"inputs":[{"name":"user","type":"address","indexed":true},{"name":"level","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]}
]
```

> 完整 JSON ABI 可由源码经 `forge inspect AgentLevel abi` 生成；上表列出 AgentReward / 前端最常用条目。

## 五、函数参数使用说明

| 函数                                                                          | 谁可调                | 参数                                   | 说明 / 示例                                                  |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------ | -------------------------------------------------------- |
| `recordPoints(member, amount)`                                              | feeder（时窗内）或 miner | member=产生积分的成员；amount=积分量            | 沿 E 链上溯 `teamDepth` 层（含本人）累加 `teamPoints`，供团队积分升级用       |
| `requestUpgrade(targetLevel)`                                               | 任意用户               | targetLevel=目标等级（> 当前、≤10）           | 入队并快照 metric；返回 requestId                                |
| `approveUpgrade(id, enforceThreshold)`                                      | 仅 miner            | id=请求号；enforceThreshold=是否强制链上校验门槛   | 审核通过落等级；`true` 时校验 `metric ≥ threshold[targetLevel]`     |
| `minerSetLevel(user, newLevel)`                                             | 仅 miner            | user；newLevel 0..10                  | 购买级别服务商品审核 / 手动补录 / 降级                                   |
| `setThreshold(lvl, amount, basis_)`                                         | 仅 miner            | lvl 1..10；amount=门槛；basis_ 0 个人/1 团队 | 每级独立配置升级门槛与基准                                            |
| `setRebateBps(rank, layer, bps)` / `setRebateBpsBatch(rank, bps[])`         | 仅 miner            | rank 1..10；layer 1..10；bps ≤10000    | 配级差制矩阵。批量：`setRebateBpsBatch(1, [1500,800,200])` 即 L1 三层 |
| `setRebateLayers(n)` / `setBasis(b)` / `setCompression(c)`                  | 仅 miner            | n 1..10；b 0 原价/1 成交价；c=bool          | 返利层数 / 计价基准 / 压缩开关（默认 3 / 原价 / 开）                        |
| `setFeeder(f, validUntil)` / `setTeamDepth(d)`                              | 仅 miner            | f=喂价器；validUntil；d 1..50             | 授权 GoodsMarket 等为团队积分喂价器                                 |
| `levelOf / isQualified / getRebateBps / rebateLayers / basis / compression` | 任何人（view）          | 见 ABI                                | AgentReward 分账时读取                                        |

## 六、SH 部署脚本（[agentlevel-deploy.sh](http://agentlevel-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail

# ===== AgentLevel 部署（防串链）=====
# 用法: PRIVATE_KEY=0x.. AGENTPOINTS=0x.. REGISTRY=0x.. ./agentlevel-deploy.sh [r9|obt|qdt]
CHAIN_KEY="${1:-r9}"

case "${CHAIN_KEY}" in
  r9)  RPC="${RPC:-<http://47.86.44.43:41546>}"; EXPECT_CHAINID=555555555 ;;
  obt) RPC="${RPC:-<http://47.86.44.43:39546>}"; EXPECT_CHAINID=1008611 ;;
  qdt) RPC="${RPC:-<http://47.86.44.43:40546>}"; EXPECT_CHAINID=88888888 ;;
  *) echo "unknown chainKey: ${CHAIN_KEY}"; exit 1 ;;
esac

: "${PRIVATE_KEY:?need PRIVATE_KEY}"
: "${AGENTPOINTS:?need AGENTPOINTS (AgentPoints 地址)}"
: "${REGISTRY:?need REGISTRY (ReferralRegistry 地址)}"
DEPLOYER="${DEPLOYER:-0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996}"
MINERS="${MINERS:-${DEPLOYER}}"
MINERS_ARR="[$(echo "${MINERS}" | tr -d ' ')]"

# ---- 防串链 ----
ACTUAL_CHAINID="$(cast chain-id --rpc-url "${RPC}")"
[ "${ACTUAL_CHAINID}" = "${EXPECT_CHAINID}" ] || { echo "❌ chainId 不符: 期望 ${EXPECT_CHAINID}, 实测 ${ACTUAL_CHAINID}"; exit 1; }
# ---- 依赖必须是合约 ----
for DEP in "${AGENTPOINTS}" "${REGISTRY}"; do
  [ "$(cast code "${DEP}" --rpc-url "${RPC}")" != "0x" ] || { echo "❌ 依赖 ${DEP} 非合约"; exit 1; }
done
echo "✅ chainId ${ACTUAL_CHAINID}; deps ok"

ADDR="$(forge create \
  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" \
  --evm-version shanghai --optimize --optimizer-runs 200 --legacy \
  src/AgentLevel.sol:AgentLevel \
  --constructor-args "${AGENTPOINTS}" "${REGISTRY}" "${MINERS_ARR}" \
  | grep 'Deployed to:' | awk '{print $3}')"
echo "AgentLevel deployed: ${ADDR}"

# ---- 部署后：写默认返利表（示例 L1..L3，可改）----
cast send "${ADDR}" 'setRebateBpsBatch(uint256,uint256[])' 1 '[1500,800,200]'  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" --legacy
cast send "${ADDR}" 'setRebateBpsBatch(uint256,uint256[])' 2 '[1800,1000,300]' --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" --legacy
cast send "${ADDR}" 'setRebateBpsBatch(uint256,uint256[])' 3 '[2000,1200,400]' --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" --legacy
# … L4..L10 按运营配置，遵循「高 rank ≥ 低 rank」

# ---- 自检 ----
echo "rebateLayers = $(cast call "${ADDR}" 'rebateLayers()(uint256)' --rpc-url "${RPC}")"
echo "basis        = $(cast call "${ADDR}" 'basis()(uint8)' --rpc-url "${RPC}")"
echo "compression  = $(cast call "${ADDR}" 'compression()(bool)' --rpc-url "${RPC}")"
echo "L1 layer1    = $(cast call "${ADDR}" 'getRebateBps(uint256,uint256)(uint256)' 1 1 --rpc-url "${RPC}")"

echo "AGENTLEVEL_${CHAIN_KEY}=${ADDR}" >> deploy.out
# 后续：AgentPoints/GoodsMarket 无需授权此合约；但 setFeeder(GoodsMarket,max) 以喂团队积分
```

## 七、完整部署参数

| 参数                     | 值 / 来源                                                                                                                                       | 说明                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| solidity / evm_version | `^0.8.24` / `shanghai`                                                                                                                       | 统一                                     |
| 构造 `agentPoints_`      | AgentPoints 部署地址（本体系第 1 份）                                                                                                                   | 个人积分燃料源                                |
| 构造 `registry_`         | ReferralRegistry(E) 地址，见 [Aeon R9 · 冷钱包上下级永久绑定：合约设计与 App/后端实施](https://app.notion.com/p/Aeon-R9-App-15a2b77e1e3e41a58b1876d5552fb079?pvs=21) | 团队积分沿 E 链上溯                            |
| 构造 `miners_`           | `[0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996]`                                                                                               | 上限 3                                   |
| 默认返利表                  | `setRebateBpsBatch(rank, [layer1,layer2,layer3])`                                                                                            | 示例 L1 `[1500,800,200]`；高 rank ≥ 低 rank |
| 默认参数                   | rebateLayers=3 / basis=0(原价) / compression=true                                                                                              | 均可 miner 调整                            |
| 部署后                    | `setFeeder(GoodsMarket, max)`、按级设 `setThreshold`                                                                                             | 喂团队积分 + 配升级门槛                          |

<aside>  
🔗

**回填位**：`AGENTLEVEL_R9 = 0x____`。地址写回 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) F 宪法登记 + 本体系总纲；AgentReward 构造需要此地址。

</aside>

## 八、r9-admin 挂载要点

- 新增类型 **AgentLevel**（分类 tab：中文「代理等级」+ 英文小字 AgentLevel）。
- 详情（read）：`agentPoints/registry/rebateLayers/basis/compression`；按地址查 `levelOf/teamPoints/isQualified`；`getRebateBps(rank,layer)` 矩阵网格；`upgradeRequestCount` + 遍历 `upgradeRequests(i)` 待审列表。
- 用户面板：`requestUpgrade(targetLevel)`。
- Miner 面板：`approveUpgrade`、`rejectUpgrade`、`minerSetLevel`、`setThreshold`、`setRebateBps/Batch`（矩阵编辑器）、`setRebateLayers/setBasis/setCompression`、`setFeeder/setTeamDepth`、`setMiner/setPaused`。
- 全局 `_alAddr` 变量避免 onclick 嵌套引号。
