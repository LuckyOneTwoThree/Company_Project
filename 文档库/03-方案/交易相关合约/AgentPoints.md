# AgentPoints.sol（代理积分 · Soulbound ERC20 · 升级燃料）

<aside>  
🎫

**定位**：代理升级的「燃料」= 不可转账积分。标准 ERC20 元数据（钱包/浏览器能识别余额），但 `transfer/transferFrom/approve` 全部 revert（soulbound）。只有授权的 `pointsSource`（或 miner）能 `mint/burn`，全部按 `refId` 幂等。AgentLevel 读本合约 `balanceOf` 作为升级达标判据。宪法参数（TOKEN/RPC/过库/miner）以 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) 「一」为准。

</aside>

## 一、设计要点

- **decimals = 6**（对应你说的「浮点 6 位小数」；积分 1.5 = 链上 `1500000`）。
- **Soulbound**：`transfer/transferFrom/approve` 恒 revert；`allowance` 恒 0；但保留 `name/symbol/decimals/totalSupply/balanceOf` 与 `Transfer` 事件（mint=from 0 地址、burn=to 0 地址），钱包与区块浏览器可正常显示余额与流水。
- **写入权限（复用 setRewarder/setConsumer 时窗范式）**：`pointsSource` 角色带 `validUntil` 到期时间戳；`mint/burn` 允许 `pointsSource`（时窗内）**或** miner 调用（miner 用于手动补录/纠错）。
- **幂等**：`mint/burn` 均按 `refId`（bytes32）去重，同一 refId 只入账一次，防重放/重试重复铸币。
- **多 miner**：`MAX_MINERS=3`，与 Claim 系列一致；至少保留 1 个 miner。
- **暂停**：`paused` 只挡 `mint`（含批量）；`burn` 不受暂停影响（保证纠错/回收随时可做）。

## 二、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentPoints - Soulbound points token (agent upgrade fuel)
/// @notice ERC20-metadata compatible but non-transferable. Only an authorized
///         pointsSource (within its time window) or a miner can mint / burn.
///         Wallets & explorers can read balances (balanceOf / totalSupply);
///         every transfer-like call reverts.
contract AgentPoints {
    // ---------- ERC20 metadata ----------
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    // ---------- Access control ----------
    uint256 public constant MAX_MINERS = 3;
    mapping(address => bool) public isMiner;
    uint256 public minerCount;
    // pointsSource => validUntil (unix ts). Authorized while now <= validUntil.
    mapping(address => uint256) public pointsSourceValidUntil;

    // ---------- Ops ----------
    bool public paused;
    mapping(bytes32 => bool) public usedRefId; // idempotency, shared by mint & burn

    // ---------- Events ----------
    event Transfer(address indexed from, address indexed to, uint256 value); // ERC20: mint from=0, burn to=0
    event Minted(address indexed to, uint256 amount, bytes32 indexed refId, address indexed by);
    event Burned(address indexed from, uint256 amount, bytes32 indexed refId, address indexed by);
    event PointsSourceSet(address indexed source, uint256 validUntil, address indexed by);
    event MinerSet(address indexed miner, bool enabled, address indexed by);
    event PausedSet(bool paused, address indexed by);

    modifier onlyMiner() {
        require(isMiner[msg.sender], "AP: not miner");
        _;
    }
    modifier whenNotPaused() {
        require(!paused, "AP: paused");
        _;
    }
    // pointsSource within window OR miner
    modifier onlySource() {
        require(
            isMiner[msg.sender] ||
                (pointsSourceValidUntil[msg.sender] != 0 &&
                    block.timestamp <= pointsSourceValidUntil[msg.sender]),
            "AP: not source"
        );
        _;
    }

    constructor(string memory name_, string memory symbol_, address[] memory miners_) {
        name = name_;
        symbol = symbol_;
        uint256 n = miners_.length;
        require(n > 0 && n <= MAX_MINERS, "AP: miners 1..3");
        for (uint256 i = 0; i < n; i++) {
            address m = miners_[i];
            require(m != address(0), "AP: zero miner");
            if (!isMiner[m]) {
                isMiner[m] = true;
                minerCount++;
                emit MinerSet(m, true, msg.sender);
            }
        }
        require(minerCount > 0, "AP: need miner");
    }

    // ---------- Soulbound: transfers disabled ----------
    function transfer(address, uint256) external pure returns (bool) {
        revert("AP: soulbound, non-transferable");
    }
    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("AP: soulbound, non-transferable");
    }
    function approve(address, uint256) external pure returns (bool) {
        revert("AP: soulbound, approvals disabled");
    }
    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    // ---------- pointsSource management (miner) ----------
    function setPointsSource(address source, uint256 validUntil) external onlyMiner {
        require(source != address(0), "AP: zero source");
        pointsSourceValidUntil[source] = validUntil;
        emit PointsSourceSet(source, validUntil, msg.sender);
    }

    function isPointsSource(address source) external view returns (bool) {
        return isMiner[source] ||
            (pointsSourceValidUntil[source] != 0 &&
                block.timestamp <= pointsSourceValidUntil[source]);
    }

    // ---------- mint / burn (source or miner) ----------
    function mint(address to, uint256 amount, bytes32 refId) external onlySource whenNotPaused {
        _mint(to, amount, refId);
    }

    function mintBatch(
        address[] calldata to,
        uint256[] calldata amount,
        bytes32[] calldata refId
    ) external onlySource whenNotPaused {
        uint256 n = to.length;
        require(n == amount.length && n == refId.length, "AP: len mismatch");
        for (uint256 i = 0; i < n; i++) {
            _mint(to[i], amount[i], refId[i]);
        }
    }

    function burn(address from, uint256 amount, bytes32 refId) external onlySource {
        require(from != address(0), "AP: burn from zero");
        require(amount > 0, "AP: zero amount");
        require(!usedRefId[refId], "AP: refId used");
        require(balanceOf[from] >= amount, "AP: insufficient");
        usedRefId[refId] = true;
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
        emit Burned(from, amount, refId, msg.sender);
    }

    function _mint(address to, uint256 amount, bytes32 refId) internal {
        require(to != address(0), "AP: mint to zero");
        require(amount > 0, "AP: zero amount");
        require(!usedRefId[refId], "AP: refId used");
        usedRefId[refId] = true;
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit Minted(to, amount, refId, msg.sender);
    }

    // ---------- miner / ops ----------
    function setMiner(address miner, bool enabled) external onlyMiner {
        require(miner != address(0), "AP: zero miner");
        if (enabled) {
            require(!isMiner[miner], "AP: already miner");
            require(minerCount < MAX_MINERS, "AP: max miners");
            isMiner[miner] = true;
            minerCount++;
        } else {
            require(isMiner[miner], "AP: not miner");
            require(minerCount > 1, "AP: need >=1 miner");
            isMiner[miner] = false;
            minerCount--;
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
const AGENTPOINTS_ABI = [
  "constructor(string name_, string symbol_, address[] miners_)",
  // ERC20 metadata (read)
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  // access / ops (read)
  "function MAX_MINERS() view returns (uint256)",
  "function isMiner(address) view returns (bool)",
  "function minerCount() view returns (uint256)",
  "function pointsSourceValidUntil(address) view returns (uint256)",
  "function isPointsSource(address source) view returns (bool)",
  "function paused() view returns (bool)",
  "function usedRefId(bytes32) view returns (bool)",
  // soulbound (always revert / 0)
  "function transfer(address, uint256) returns (bool)",
  "function transferFrom(address, address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  // write
  "function setPointsSource(address source, uint256 validUntil)",
  "function mint(address to, uint256 amount, bytes32 refId)",
  "function mintBatch(address[] to, uint256[] amount, bytes32[] refId)",
  "function burn(address from, uint256 amount, bytes32 refId)",
  "function setMiner(address miner, bool enabled)",
  "function setPaused(bool p)",
  // events
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Minted(address indexed to, uint256 amount, bytes32 indexed refId, address indexed by)",
  "event Burned(address indexed from, uint256 amount, bytes32 indexed refId, address indexed by)",
  "event PointsSourceSet(address indexed source, uint256 validUntil, address indexed by)",
  "event MinerSet(address indexed miner, bool enabled, address indexed by)",
  "event PausedSet(bool paused, address indexed by)"
];
```

### 3.2 JSON ABI

```json
[
  {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"name_","type":"string"},{"name":"symbol_","type":"string"},{"name":"miners_","type":"address[]"}]},
  {"type":"function","name":"name","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
  {"type":"function","name":"symbol","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
  {"type":"function","name":"decimals","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
  {"type":"function","name":"totalSupply","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"MAX_MINERS","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"isMiner","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"minerCount","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"pointsSourceValidUntil","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"isPointsSource","stateMutability":"view","inputs":[{"name":"source","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"paused","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"usedRefId","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"transfer","stateMutability":"pure","inputs":[{"name":"","type":"address"},{"name":"","type":"uint256"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"transferFrom","stateMutability":"pure","inputs":[{"name":"","type":"address"},{"name":"","type":"address"},{"name":"","type":"uint256"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"approve","stateMutability":"pure","inputs":[{"name":"","type":"address"},{"name":"","type":"uint256"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"allowance","stateMutability":"pure","inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"setPointsSource","stateMutability":"nonpayable","inputs":[{"name":"source","type":"address"},{"name":"validUntil","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"mint","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"},{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"mintBatch","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address[]"},{"name":"amount","type":"uint256[]"},{"name":"refId","type":"bytes32[]"}],"outputs":[]},
  {"type":"function","name":"burn","stateMutability":"nonpayable","inputs":[{"name":"from","type":"address"},{"name":"amount","type":"uint256"},{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"setMiner","stateMutability":"nonpayable","inputs":[{"name":"miner","type":"address"},{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setPaused","stateMutability":"nonpayable","inputs":[{"name":"p","type":"bool"}],"outputs":[]},
  {"type":"event","name":"Transfer","anonymous":false,"inputs":[{"name":"from","type":"address","indexed":true},{"name":"to","type":"address","indexed":true},{"name":"value","type":"uint256","indexed":false}]},
  {"type":"event","name":"Minted","anonymous":false,"inputs":[{"name":"to","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false},{"name":"refId","type":"bytes32","indexed":true},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"Burned","anonymous":false,"inputs":[{"name":"from","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false},{"name":"refId","type":"bytes32","indexed":true},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"PointsSourceSet","anonymous":false,"inputs":[{"name":"source","type":"address","indexed":true},{"name":"validUntil","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"MinerSet","anonymous":false,"inputs":[{"name":"miner","type":"address","indexed":true},{"name":"enabled","type":"bool","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"PausedSet","anonymous":false,"inputs":[{"name":"paused","type":"bool","indexed":false},{"name":"by","type":"address","indexed":true}]}
]
```

## 四、函数参数使用说明

| 函数                                                 | 谁可调                      | 参数                                                                 | 说明 / 示例                                                      |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `mint(to, amount, refId)`                          | pointsSource（时窗内）或 miner | to=收积分地址；amount=数量（6 位小数，1.5 分=`1500000`）；refId=幂等键 bytes32        | 购买级别服务商品后由 GoodsMarket 触发。`c.mint(user, 1500000n, refId)`    |
| `mintBatch(to[], amount[], refId[])`               | pointsSource 或 miner     | 三个等长数组                                                             | 批量补录/发放，省 gas；任一 refId 已用即整笔 revert                          |
| `burn(from, amount, refId)`                        | pointsSource 或 miner     | from=扣积分地址；amount；refId                                            | 纠错/回收；不受 paused 影响；余额不足 revert                               |
| `setPointsSource(source, validUntil)`              | 仅 miner                  | source=授权合约/地址；validUntil=到期 unix 秒（`type(uint256).max` 长期、`0` 撤销） | 授权 GoodsMarket 为积分来源：`c.setPointsSource(goods, 2n**256n-1n)` |
| `isPointsSource(source)`                           | 任何人（view）                | source                                                             | 返回是否当前有效来源（miner 恒 true，或时窗内）                                |
| `setMiner(miner, enabled)`                         | 仅 miner                  | miner；enabled=true 增/false 删                                       | 上限 3、至少留 1 个                                                 |
| `setPaused(p)`                                     | 仅 miner                  | p=bool                                                             | 暂停仅挡 mint / mintBatch                                        |
| `balanceOf(addr)` / `totalSupply()` / `decimals()` | 任何人（view）                | —                                                                  | 钱包/浏览器/AgentLevel 读取积分                                       |
| `transfer` / `transferFrom` / `approve`            | ——                       | ——                                                                 | **恒 revert（soulbound）**；`allowance` 恒返回 0                    |

> **refId 约定**：建议 `refId = keccak256(abi.encode(chainId, "AGP", sourceTag, orderId))`，与来源订单一一对应，天然幂等、便于对账。GoodsMarket 触发积分时用其订单 refId 派生。

## 五、SH 部署脚本（[agentpoints-deploy.sh](http://agentpoints-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail

# ===== AgentPoints 部署（防串链）=====
# 用法: PRIVATE_KEY=0x.. ./agentpoints-deploy.sh [r9|obt|qdt]
CHAIN_KEY="${1:-r9}"

# ---- 链参数（宪法值：链ID + 43 外网 RPC）----
case "${CHAIN_KEY}" in
  r9)  RPC="${RPC:-<http://47.86.44.43:41546>}"; EXPECT_CHAINID=555555555 ;;
  obt) RPC="${RPC:-<http://47.86.44.43:39546>}"; EXPECT_CHAINID=1008611 ;;
  qdt) RPC="${RPC:-<http://47.86.44.43:40546>}"; EXPECT_CHAINID=88888888 ;;
  *) echo "unknown chainKey: ${CHAIN_KEY}"; exit 1 ;;
esac

: "${PRIVATE_KEY:?need PRIVATE_KEY}"
DEPLOYER="${DEPLOYER:-0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996}"

# ---- 构造参数 ----
AP_NAME="${AP_NAME:-Agent Points}"
AP_SYMBOL="${AP_SYMBOL:-AGP}"
MINERS="${MINERS:-${DEPLOYER}}"          # 逗号分隔，默认部署者一人
MINERS_ARR="[$(echo "${MINERS}" | tr -d ' ')]"

# ---- 铁律：cast chain-id 实测防串链 ----
ACTUAL_CHAINID="$(cast chain-id --rpc-url "${RPC}")"
if [ "${ACTUAL_CHAINID}" != "${EXPECT_CHAINID}" ]; then
  echo "❌ chainId 不符: 期望 ${EXPECT_CHAINID}, 实测 ${ACTUAL_CHAINID} (RPC ${RPC})"; exit 1
fi
echo "✅ chainId ${ACTUAL_CHAINID} @ ${RPC}"

# ---- 部署（evm_version=shanghai，与 Claim 系列一致）----
ADDR="$(forge create \
  --rpc-url "${RPC}" \
  --private-key "${PRIVATE_KEY}" \
  --evm-version shanghai \
  --optimize --optimizer-runs 200 \
  --legacy \
  src/AgentPoints.sol:AgentPoints \
  --constructor-args "${AP_NAME}" "${AP_SYMBOL}" "${MINERS_ARR}" \
  | grep 'Deployed to:' | awk '{print $3}')"
echo "AgentPoints deployed: ${ADDR}"

# ---- 部署后自检 ----
echo "decimals   = $(cast call "${ADDR}" 'decimals()(uint8)' --rpc-url "${RPC}")"
echo "name       = $(cast call "${ADDR}" 'name()(string)' --rpc-url "${RPC}")"
echo "minerCount = $(cast call "${ADDR}" 'minerCount()(uint256)' --rpc-url "${RPC}")"
echo "isMiner(dep)= $(cast call "${ADDR}" 'isMiner(address)(bool)' "${DEPLOYER}" --rpc-url "${RPC}")"
# 反例自检：soulbound —— transfer 必须 revert
if cast call "${ADDR}" 'transfer(address,uint256)(bool)' "${DEPLOYER}" 1 --rpc-url "${RPC}" 2>/dev/null; then
  echo "❌ transfer 未 revert，soulbound 失效"; exit 1
else
  echo "✅ transfer 已 revert（soulbound 生效）"
fi

echo "AGENTPOINTS_${CHAIN_KEY}=${ADDR}" >> deploy.out
```

## 六、完整部署参数

| 参数            | 值 / 来源                                            | 说明                      |
| ------------- | ------------------------------------------------- | ----------------------- |
| solidity      | `^0.8.24`                                         | 与新合约体系统一                |
| evm_version   | `shanghai`                                        | 对齐 R9 Claim 系列          |
| 构造 `name_`    | `Agent Points`                                    | 可改                      |
| 构造 `symbol_`  | `AGP`                                             | 可改                      |
| 构造 `miners_`  | `[0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996]`    | 初始 miner（部署者），上限 3      |
| RPC / chainId | R9 `47.86.44.43:41546` / `555555555`（OB/QDT 见脚本）  | cast chain-id 实测校验      |
| 部署后授权         | `setPointsSource(GoodsMarket, type(uint256).max)` | GoodsMarket 部署后回填其地址再授权 |

<aside>  
🔗

**回填位（部署后）**：`AGENTPOINTS_R9 = 0x____`（写回 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) F 宪法登记 + 本体系总纲）。授权 GoodsMarket 为 pointsSource 需等 H 部署完成拿到地址。

</aside>

## 七、r9-admin 挂载要点

- 新增合约类型 **AgentPoints**（分类 tab：中文「代理积分」+ 英文小字 AgentPoints）。
- 详情面板（read）：`name/symbol/decimals/totalSupply`、按地址查 `balanceOf`、`minerCount`、按地址查 `isPointsSource`。
- Miner 面板（write）：`setPointsSource(addr,validUntil)`（含「长期 = max / 撤销 = 0」快捷）、`mint`、`mintBatch`、`burn`、`setMiner`、`setPaused`。
- 用全局 `_apAddr` 变量避免 onclick 嵌套引号。
