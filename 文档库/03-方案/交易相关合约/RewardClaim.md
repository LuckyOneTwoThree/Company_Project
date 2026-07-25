# RewardClaim.sol（额度制奖励领取 · 单币 · 撤销/退回）

<aside>  
🎁

**定位**：奖励「落地」合约。GoodsMarket / AgentReward 通过 `addReward` 写入用户额度，用户自付 gas 调 `claim()` 领取（**无中继、无 miner 手动发放**）。支持两类撤销：①`revokeReward` 撤销**未领取**额度（限时活动到期/防刷单）；②`returnReward` 用户**主动退回已领奖励币**（已购退款前置条件）。每个实例只服务单一 TOKEN；多币场景由「多个单币 RewardClaim 实例」组合。宪法参数以 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) 「一」为准。

</aside>

## 一、设计要点

- **额度制**：`allocation[user]` 记净额度，`claimedAmount[user]` 记已领，`claimable = allocation - claimed`；用户随时自领。
- **单币**：构造锁定一个 `token`；多币由多实例组合（与你的「claim 不做多币逻辑」定案一致）。
- **合约直写权限（预留）**：`rewarder` 角色带 `validUntil` 时窗；`addReward/revokeReward` 允许 rewarder（时窗内）或 miner。GoodsMarket、AgentReward 部署后被授权为 rewarder。
- **预算护栏**：每个 rewarder 有 `budget` 上限与 `spent` 累计，防止单一来源超额写入。
- **偿付会计**：`totalAllocated / totalClaimed / totalReturned`，`outstanding = 已分配 − 已领`，`shortfall` 实时暴露缺口；`addReward` 内置 `requireFunded`——合约必须已充值到能覆盖全部未领额度，否则拒绝写入。
- **两类撤销**（对应你的定案）：
  - `revokeReward(refId)`：撤销**尚未领取**的那笔额度（活动到期/防刷单），只回收未领部分；已领的动不了。
  - `returnReward(refId, amount)`：奖励**已被领走**后，用户主动把奖励币转回本合约（退货退款场景），记 `returnedAmount`；GoodsMarket 审核退货时以此为前置硬条件。
- **多 miner**：`MAX_MINERS=3`；`rescue` 只能提走「超出未领额度的盈余」到 treasury，动不了用户应得。

> ⚠️ 已上线的 6 份审计版 Claim（DailyClaim/WhitelistClaim 等）**不回改**；本合约是交易/返利体系专用的新实例。

## 二、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title RewardClaim - allocation-based single-token reward vault
/// @notice Rewarders (GoodsMarket / AgentReward) write allocations; users self
///         claim. Supports revoke (unclaimed clawback) and voluntary return.
contract RewardClaim {
    IERC20 public immutable token;
    address public treasury;

    uint256 public constant MAX_MINERS = 3;
    mapping(address => bool) public isMiner;
    uint256 public minerCount;

    // rewarder => validUntil (unix ts); miner is always a rewarder
    mapping(address => uint256) public rewarderValidUntil;
    mapping(address => uint256) public budget; // per-rewarder cap
    mapping(address => uint256) public spent;  // per-rewarder used

    struct Reward {
        address user;
        uint256 amount;
        address rewarder;
        bool revoked;
        uint256 returnedAmount;
    }
    mapping(bytes32 => Reward) public rewards; // refId => Reward

    mapping(address => uint256) public allocation;    // net entitlement
    mapping(address => uint256) public claimedAmount; // claimed so far

    uint256 public totalAllocated;
    uint256 public totalClaimed;
    uint256 public totalReturned;

    bool public paused;

    event RewarderSet(address indexed rewarder, uint256 validUntil, address indexed by);
    event BudgetSet(address indexed rewarder, uint256 amount, address indexed by);
    event RewardAdded(address indexed user, uint256 amount, bytes32 indexed refId, address indexed rewarder);
    event Claimed(address indexed user, uint256 amount);
    event RewardRevoked(bytes32 indexed refId, address indexed user, uint256 amount, address indexed by);
    event RewardReturned(bytes32 indexed refId, address indexed user, uint256 amount);
    event MinerSet(address indexed miner, bool enabled, address indexed by);
    event PausedSet(bool paused, address indexed by);
    event TreasurySet(address indexed treasury, address indexed by);
    event Rescued(address indexed to, uint256 amount);

    modifier onlyMiner() { require(isMiner[msg.sender], "RC: not miner"); _; }
    modifier onlyRewarder() { require(isRewarder(msg.sender), "RC: not rewarder"); _; }
    modifier whenNotPaused() { require(!paused, "RC: paused"); _; }

    constructor(address token_, address treasury_, address[] memory miners_) {
        require(token_ != address(0), "RC: zero token");
        require(treasury_ != address(0), "RC: zero treasury");
        token = IERC20(token_);
        treasury = treasury_;
        uint256 n = miners_.length;
        require(n > 0 && n <= MAX_MINERS, "RC: miners 1..3");
        for (uint256 i = 0; i < n; i++) {
            address m = miners_[i];
            require(m != address(0), "RC: zero miner");
            if (!isMiner[m]) { isMiner[m] = true; minerCount++; emit MinerSet(m, true, msg.sender); }
        }
    }

    function isRewarder(address a) public view returns (bool) {
        return isMiner[a] ||
            (rewarderValidUntil[a] != 0 && block.timestamp <= rewarderValidUntil[a]);
    }

    // ---------- write allocation (rewarder / miner) ----------
    function addReward(address user, uint256 amount, bytes32 refId)
        external onlyRewarder whenNotPaused
    {
        require(user != address(0), "RC: zero user");
        require(amount > 0, "RC: zero amount");
        require(rewards[refId].user == address(0), "RC: refId used");
        if (!isMiner[msg.sender]) {
            require(spent[msg.sender] + amount <= budget[msg.sender], "RC: over budget");
            spent[msg.sender] += amount;
        }
        rewards[refId] = Reward(user, amount, msg.sender, false, 0);
        allocation[user] += amount;
        totalAllocated += amount;
        // solvency: must be pre-funded to cover all outstanding entitlements
        require(token.balanceOf(address(this)) >= totalAllocated - totalClaimed, "RC: underfunded");
        emit RewardAdded(user, amount, refId, msg.sender);
    }

    // ---------- claim (user self-service) ----------
    function claim() external whenNotPaused {
        uint256 amt = allocation[msg.sender] - claimedAmount[msg.sender];
        require(amt > 0, "RC: nothing to claim");
        claimedAmount[msg.sender] += amt;
        totalClaimed += amt;
        require(token.transfer(msg.sender, amt), "RC: transfer failed");
        emit Claimed(msg.sender, amt);
    }

    // ---------- revoke UNCLAIMED (campaign expiry / anti-fraud) ----------
    function revokeReward(bytes32 refId) external onlyRewarder {
        Reward storage r = rewards[refId];
        require(r.user != address(0), "RC: no reward");
        require(!r.revoked, "RC: already revoked");
        uint256 unclaimed = allocation[r.user] - claimedAmount[r.user];
        require(unclaimed >= r.amount, "RC: already claimed");
        r.revoked = true;
        allocation[r.user] -= r.amount;
        totalAllocated -= r.amount;
        if (r.rewarder != address(0) && !isMiner[r.rewarder] && spent[r.rewarder] >= r.amount) {
            spent[r.rewarder] -= r.amount;
        }
        emit RewardRevoked(refId, r.user, r.amount, msg.sender);
    }

    // ---------- voluntary return of ALREADY-CLAIMED reward (refund path) ----------
    function returnReward(bytes32 refId, uint256 amount) external {
        Reward storage r = rewards[refId];
        require(r.user != address(0), "RC: no reward");
        require(msg.sender == r.user, "RC: not reward owner");
        require(amount > 0 && r.returnedAmount + amount <= r.amount, "RC: over return");
        r.returnedAmount += amount;
        totalReturned += amount;
        require(token.transferFrom(msg.sender, address(this), amount), "RC: transferFrom failed");
        emit RewardReturned(refId, r.user, amount);
    }

    // ---------- views ----------
    function claimable(address user) external view returns (uint256) {
        return allocation[user] - claimedAmount[user];
    }
    function outstanding() public view returns (uint256) {
        return totalAllocated - totalClaimed;
    }
    function shortfall() external view returns (uint256) {
        uint256 out = outstanding();
        uint256 bal = token.balanceOf(address(this));
        return bal >= out ? 0 : out - bal;
    }

    // ---------- admin ----------
    function setRewarder(address rewarder, uint256 validUntil) external onlyMiner {
        require(rewarder != address(0), "RC: zero rewarder");
        rewarderValidUntil[rewarder] = validUntil;
        emit RewarderSet(rewarder, validUntil, msg.sender);
    }
    function setBudget(address rewarder, uint256 amount) external onlyMiner {
        budget[rewarder] = amount;
        emit BudgetSet(rewarder, amount, msg.sender);
    }
    function setTreasury(address t) external onlyMiner {
        require(t != address(0), "RC: zero treasury");
        treasury = t;
        emit TreasurySet(t, msg.sender);
    }
    function rescue(uint256 amount) external onlyMiner {
        uint256 bal = token.balanceOf(address(this));
        uint256 out = outstanding();
        require(bal >= out && bal - out >= amount, "RC: no surplus");
        require(token.transfer(treasury, amount), "RC: transfer failed");
        emit Rescued(treasury, amount);
    }
    function setMiner(address miner, bool enabled) external onlyMiner {
        require(miner != address(0), "RC: zero miner");
        if (enabled) {
            require(!isMiner[miner], "RC: already miner");
            require(minerCount < MAX_MINERS, "RC: max miners");
            isMiner[miner] = true; minerCount++;
        } else {
            require(isMiner[miner], "RC: not miner");
            require(minerCount > 1, "RC: need >=1 miner");
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
const REWARDCLAIM_ABI = [
  "constructor(address token_, address treasury_, address[] miners_)",
  // reads
  "function token() view returns (address)",
  "function treasury() view returns (address)",
  "function MAX_MINERS() view returns (uint256)",
  "function isMiner(address) view returns (bool)",
  "function minerCount() view returns (uint256)",
  "function rewarderValidUntil(address) view returns (uint256)",
  "function isRewarder(address a) view returns (bool)",
  "function budget(address) view returns (uint256)",
  "function spent(address) view returns (uint256)",
  "function rewards(bytes32) view returns (address user, uint256 amount, address rewarder, bool revoked, uint256 returnedAmount)",
  "function allocation(address) view returns (uint256)",
  "function claimedAmount(address) view returns (uint256)",
  "function claimable(address user) view returns (uint256)",
  "function totalAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function totalReturned() view returns (uint256)",
  "function outstanding() view returns (uint256)",
  "function shortfall() view returns (uint256)",
  "function paused() view returns (bool)",
  // writes
  "function addReward(address user, uint256 amount, bytes32 refId)",
  "function claim()",
  "function revokeReward(bytes32 refId)",
  "function returnReward(bytes32 refId, uint256 amount)",
  "function setRewarder(address rewarder, uint256 validUntil)",
  "function setBudget(address rewarder, uint256 amount)",
  "function setTreasury(address t)",
  "function rescue(uint256 amount)",
  "function setMiner(address miner, bool enabled)",
  "function setPaused(bool p)",
  // events
  "event RewarderSet(address indexed rewarder, uint256 validUntil, address indexed by)",
  "event BudgetSet(address indexed rewarder, uint256 amount, address indexed by)",
  "event RewardAdded(address indexed user, uint256 amount, bytes32 indexed refId, address indexed rewarder)",
  "event Claimed(address indexed user, uint256 amount)",
  "event RewardRevoked(bytes32 indexed refId, address indexed user, uint256 amount, address indexed by)",
  "event RewardReturned(bytes32 indexed refId, address indexed user, uint256 amount)",
  "event MinerSet(address indexed miner, bool enabled, address indexed by)",
  "event PausedSet(bool paused, address indexed by)",
  "event TreasurySet(address indexed treasury, address indexed by)",
  "event Rescued(address indexed to, uint256 amount)"
];
```

### 3.2 JSON ABI

```json
[
  {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"token_","type":"address"},{"name":"treasury_","type":"address"},{"name":"miners_","type":"address[]"}]},
  {"type":"function","name":"token","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
  {"type":"function","name":"treasury","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
  {"type":"function","name":"MAX_MINERS","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"isMiner","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"minerCount","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"rewarderValidUntil","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"isRewarder","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"budget","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"spent","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"rewards","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"name":"user","type":"address"},{"name":"amount","type":"uint256"},{"name":"rewarder","type":"address"},{"name":"revoked","type":"bool"},{"name":"returnedAmount","type":"uint256"}]},
  {"type":"function","name":"allocation","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"claimedAmount","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"claimable","stateMutability":"view","inputs":[{"name":"user","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"totalAllocated","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"totalClaimed","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"totalReturned","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"outstanding","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"shortfall","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"paused","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"addReward","stateMutability":"nonpayable","inputs":[{"name":"user","type":"address"},{"name":"amount","type":"uint256"},{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"claim","stateMutability":"nonpayable","inputs":[],"outputs":[]},
  {"type":"function","name":"revokeReward","stateMutability":"nonpayable","inputs":[{"name":"refId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"returnReward","stateMutability":"nonpayable","inputs":[{"name":"refId","type":"bytes32"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setRewarder","stateMutability":"nonpayable","inputs":[{"name":"rewarder","type":"address"},{"name":"validUntil","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setBudget","stateMutability":"nonpayable","inputs":[{"name":"rewarder","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setTreasury","stateMutability":"nonpayable","inputs":[{"name":"t","type":"address"}],"outputs":[]},
  {"type":"function","name":"rescue","stateMutability":"nonpayable","inputs":[{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setMiner","stateMutability":"nonpayable","inputs":[{"name":"miner","type":"address"},{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setPaused","stateMutability":"nonpayable","inputs":[{"name":"p","type":"bool"}],"outputs":[]},
  {"type":"event","name":"RewarderSet","anonymous":false,"inputs":[{"name":"rewarder","type":"address","indexed":true},{"name":"validUntil","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"BudgetSet","anonymous":false,"inputs":[{"name":"rewarder","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"RewardAdded","anonymous":false,"inputs":[{"name":"user","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false},{"name":"refId","type":"bytes32","indexed":true},{"name":"rewarder","type":"address","indexed":true}]},
  {"type":"event","name":"Claimed","anonymous":false,"inputs":[{"name":"user","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}]},
  {"type":"event","name":"RewardRevoked","anonymous":false,"inputs":[{"name":"refId","type":"bytes32","indexed":true},{"name":"user","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"RewardReturned","anonymous":false,"inputs":[{"name":"refId","type":"bytes32","indexed":true},{"name":"user","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}]},
  {"type":"event","name":"MinerSet","anonymous":false,"inputs":[{"name":"miner","type":"address","indexed":true},{"name":"enabled","type":"bool","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"PausedSet","anonymous":false,"inputs":[{"name":"paused","type":"bool","indexed":false},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"TreasurySet","anonymous":false,"inputs":[{"name":"treasury","type":"address","indexed":true},{"name":"by","type":"address","indexed":true}]},
  {"type":"event","name":"Rescued","anonymous":false,"inputs":[{"name":"to","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}]}
]
```

## 四、函数参数使用说明

| 函数                                    | 谁可调                  | 参数                                                | 说明 / 示例                                                                                   |
| ------------------------------------- | -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `addReward(user, amount, refId)`      | rewarder（时窗内）或 miner | user=收益人；amount=奖励额（该 token 精度）；refId=幂等键         | GoodsMarket/AgentReward 写入额度；受 budget 限制；写后要求合约已充值覆盖未领额。`c.addReward(u, amt, refId)`      |
| `claim()`                             | 任何有额度的用户             | —                                                 | 自付 gas 领取全部 `claimable`；无中继                                                               |
| `revokeReward(refId)`                 | rewarder 或 miner     | refId                                             | 撤销**未领取**额度（活动到期/防刷单）；已领则 revert（`RC: already claimed`）                                   |
| `returnReward(refId, amount)`         | 该 refId 的用户本人        | refId；amount=退回额                                  | 已领奖励退货退款：先 `approve` 本合约再调用，把币转回池；GoodsMarket 审核退货前置条件（查 `rewards(refId).returnedAmount`） |
| `setRewarder(rewarder, validUntil)`   | 仅 miner              | rewarder=授权合约；validUntil=到期 unix 秒（max 长期 / 0 撤销） | 授权 GoodsMarket、AgentReward 直写                                                             |
| `setBudget(rewarder, amount)`         | 仅 miner              | rewarder；amount=累计写入上限                            | 护栏，防单一来源超额                                                                                |
| `rescue(amount)`                      | 仅 miner              | amount                                            | 只能提「盈余（余额 − 未领额）」到 treasury；动不了用户应得                                                       |
| `claimable / outstanding / shortfall` | 任何人（view）            | —                                                 | 偿付监控：`shortfall>0` 即需补充资金                                                                 |
| `setTreasury / setMiner / setPaused`  | 仅 miner              | 见 ABI                                             | 常规运维；paused 挡 addReward 与 claim                                                           |

> **refId 约定**：`refId = keccak256(abi.encode(chainId, sku, orderId))`（买家自身奖励）；AgentReward 分层返利用 `keccak256(abi.encode(orderRefId, layer))`，保证每层每单唯一、可精准 `revoke`。

## 五、SH 部署脚本（[rewardclaim-deploy.sh](http://rewardclaim-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail

# ===== RewardClaim 部署（防串链）=====
# 用法: PRIVATE_KEY=0x.. TOKEN=0x.. TREASURY=0x.. ./rewardclaim-deploy.sh [r9|obt|qdt]
CHAIN_KEY="${1:-r9}"

case "${CHAIN_KEY}" in
  r9)  RPC="${RPC:-<http://47.86.44.43:41546>}"; EXPECT_CHAINID=555555555 ;;
  obt) RPC="${RPC:-<http://47.86.44.43:39546>}"; EXPECT_CHAINID=1008611 ;;
  qdt) RPC="${RPC:-<http://47.86.44.43:40546>}"; EXPECT_CHAINID=88888888 ;;
  *) echo "unknown chainKey: ${CHAIN_KEY}"; exit 1 ;;
esac

: "${PRIVATE_KEY:?need PRIVATE_KEY}"
: "${TOKEN:?need TOKEN (奖励币地址)}"
DEPLOYER="${DEPLOYER:-0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996}"
TREASURY="${TREASURY:-${DEPLOYER}}"
MINERS="${MINERS:-${DEPLOYER}}"
MINERS_ARR="[$(echo "${MINERS}" | tr -d ' ')]"

# ---- 防串链 ----
ACTUAL_CHAINID="$(cast chain-id --rpc-url "${RPC}")"
if [ "${ACTUAL_CHAINID}" != "${EXPECT_CHAINID}" ]; then
  echo "❌ chainId 不符: 期望 ${EXPECT_CHAINID}, 实测 ${ACTUAL_CHAINID}"; exit 1
fi
# ---- token 必须是合约（防填错空地址）----
if [ "$(cast code "${TOKEN}" --rpc-url "${RPC}")" = "0x" ]; then
  echo "❌ TOKEN ${TOKEN} 非合约地址"; exit 1
fi
echo "✅ chainId ${ACTUAL_CHAINID} @ ${RPC}; token ok"

ADDR="$(forge create \
  --rpc-url "${RPC}" \
  --private-key "${PRIVATE_KEY}" \
  --evm-version shanghai \
  --optimize --optimizer-runs 200 \
  --legacy \
  src/RewardClaim.sol:RewardClaim \
  --constructor-args "${TOKEN}" "${TREASURY}" "${MINERS_ARR}" \
  | grep 'Deployed to:' | awk '{print $3}')"
echo "RewardClaim deployed: ${ADDR}"

# ---- 自检 ----
echo "token      = $(cast call "${ADDR}" 'token()(address)' --rpc-url "${RPC}")"
echo "treasury   = $(cast call "${ADDR}" 'treasury()(address)' --rpc-url "${RPC}")"
echo "minerCount = $(cast call "${ADDR}" 'minerCount()(uint256)' --rpc-url "${RPC}")"
echo "outstanding= $(cast call "${ADDR}" 'outstanding()(uint256)' --rpc-url "${RPC}")"

echo "REWARDCLAIM_${CHAIN_KEY}=${ADDR}" >> deploy.out
# 部署后：1) 给合约充值奖励币  2) setRewarder(GoodsMarket/AgentReward, max)  3) setBudget(...)
```

## 六、完整部署参数

| 参数                     | 值 / 来源                                                                                       | 说明                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| solidity / evm_version | `^0.8.24` / `shanghai`                                                                       | 对齐 Claim 系列                                                 |
| 构造 `token_`            | 奖励币地址（按链选，见 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) 「一」） | R9 例：HRC `0x951a23118B1d9DDaCCD2e284367464fF232b1627`；每实例单币 |
| 构造 `treasury_`         | 盈余回收地址（默认部署者）                                                                                | `rescue` 目标                                                 |
| 构造 `miners_`           | `[0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996]`                                               | 上限 3                                                        |
| 部署后 1                  | 向合约转入奖励币                                                                                     | `addReward` 有 requireFunded 硬约束，必须先充值                       |
| 部署后 2                  | `setRewarder(GoodsMarket, max)`、`setRewarder(AgentReward, max)`                              | 授权直写                                                        |
| 部署后 3                  | `setBudget(rewarder, cap)`                                                                   | 可选护栏                                                        |

<aside>  
🔗

**回填位**：每个奖励币一份实例，如 `REWARDCLAIM_HRC_R9 = 0x____`、`REWARDCLAIM_USDR_R9 = 0x____`。地址写回 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) F 宪法登记 + 本体系总纲。

</aside>

## 七、r9-admin 挂载要点

- 新增类型 **RewardClaim**（分类 tab：中文「奖励领取」+ 英文小字 RewardClaim）。
- 详情（read）：`token/treasury/totalAllocated/totalClaimed/totalReturned/outstanding/shortfall`；按地址查 `allocation/claimedAmount/claimable`；按 refId 查 `rewards`。
- 用户面板：`claim()`、`returnReward(refId,amount)`（含 approve 引导）。
- Miner 面板：`setRewarder`、`setBudget`、`revokeReward`、`rescue`、`setTreasury`、`setMiner`、`setPaused`。
- 全局 `_rcAddr` 变量避免 onclick 嵌套引号。
