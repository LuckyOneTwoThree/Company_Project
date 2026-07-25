# GoodsMarket.sol（商品/虚拟品买卖 · 多币价 · 唯一码库存 · 转卖 · 退货审核）

<aside>  
🛒

**定位**：本体系唯一面向用户的**商品/虚拟品买卖合约**（非 NFT；500 库存 = 500 个唯一识别码）。支持多商品、多支付 TOKEN 定价、MOQ、按量折扣阶梯（支付原价 70/60/50%）、唯一码库存台账、购买记录、转卖（直转 + 挂单回购）、退货（miner 审核 + 关联奖励先退回前置）、全功能黑白名单 + 上下架。购买同交易内联动 **AgentReward.onPurchase** + [**AgentPoints.mint**](http://AgentPoints.mint) + **AgentLevel.recordPoints**（无中继、无手动）。宪法参数以 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) H 为准。

</aside>

## 一、设计要点

- **商品**：`createProduct/updateProduct`；`productId` 自增；`name / minOrderQty / secretCode / resaleFeeBps / pointsPerUnit / feedTeamPoints / active`。
- **多币定价**：`price[productId][token]`；`0` 表示不接受该币。
- **折扣阶梯**：`tiers[]=(minQty, bps)`，`bps=支付原价比例`（7000=70%、6000=60%、5000=50%）；取满足条件的**最高 minQty** 那档；默认 10000=原价。
- **唯一码库存（非 NFT）**：`importCodes(productId, bytes32[])` 导入；`codeStatus`（0 未设/1 可售/2 已售/3 已退）、`codeProduct`、`codeOwner`、`ownedCodes[addr]`；买时按数量出库。
- **保密开关**：`secretCode` 逐商品开关；`productCodes()` 列表对保密商品仅 miner 可读（链上数据本质公开，此为 API 层限制 + 建议存哈希，真实码体链下映射）。
- **转卖（两者都要）**：`transferItem`（直转/赠送）+ `listItem/buyListed/cancelListing`（挂单回购，`resaleFeeBps` 抽成入 treasury）。
- **退货（需审核）**：`returnRequest` → miner `approveReturn(id, refundAmount)` / `rejectReturn`；批准时自动 `AgentReward.revokeOrder`（回收未领取返利），**已领奖励需买家先 `RewardClaim.returnReward` 退回原合约后 miner 才审核**；`getReturnRequest` 供 miner 直取 地址-产品-金额。
- **黑白名单 + 上下架**：`setBanned`、`whitelistEnabled`+`setWhitelist(Batch)`、`setProductActive`。
- **联动**：购买同交易 `AgentReward.onPurchase`（返利）+ `AgentPoints.mint`（级别服务/积分商品）+ `AgentLevel.recordPoints`（团队积分）；钩子用 try/catch 保证主交易 + 发码原子性。
- **直写奖励**：`rewards[]=(claim, mode, amountOrBps)`，购后写 TOKEN 奖励进指定 claim（mode 0 固定 / 1 按成交比例），用户自动领取、可撤销。
- **多 miner / 暂停 / 资金**：`MAX_MINERS=3`；`paused`；售款暂存合约内，便于退款，miner `withdraw` 提利至 treasury。

## 二、完整合约源码

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}
interface IAgentReward {
    function onPurchase(address buyer, uint256 productId, uint256 grossPrice, uint256 netPrice, address payToken, bytes32 refId) external;
    function revokeOrder(bytes32 refId) external;
}
interface IAgentPoints {
    function mint(address to, uint256 amount, bytes32 refId) external;
}
interface IAgentLevel {
    function recordPoints(address member, uint256 amount) external;
}
interface IRewardClaim {
    function addReward(address user, uint256 amount, bytes32 refId) external;
}

/// @title GoodsMarket - multi-product store with unique-code inventory,
///        tiered discounts, resale, reviewed returns, and agent hooks.
contract GoodsMarket {
    uint256 public constant MAX_MINERS = 3;
    mapping(address => bool) public isMiner;
    uint256 public minerCount;
    address public treasury;
    bool public paused;

    IAgentReward public agentReward;
    IAgentPoints public agentPoints;
    IAgentLevel public agentLevel;

    mapping(address => bool) public banned;
    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;

    struct Tier { uint256 minQty; uint256 bps; }             // bps = % of original to PAY
    struct RewardCfg { address claim; uint8 mode; uint256 amountOrBps; } // 0 fixed/unit, 1 bps of paid

    struct Product {
        bool exists;
        bool active;
        bool secretCode;
        uint256 minOrderQty;
        uint256 resaleFeeBps;
        uint256 pointsPerUnit;
        bool feedTeamPoints;
        string name;
    }
    uint256 public productCount;
    mapping(uint256 => Product) public products;
    mapping(uint256 => mapping(address => uint256)) public price; // productId => token => unit price
    mapping(uint256 => Tier[]) internal _tiers;
    mapping(uint256 => RewardCfg[]) internal _rewards;
    mapping(uint256 => bytes32[]) internal _available;           // productId => available code ids
    mapping(uint256 => uint256) public sold;

    mapping(bytes32 => uint8) public codeStatus;   // 0 unset,1 available,2 sold,3 returned
    mapping(bytes32 => uint256) public codeProduct;
    mapping(bytes32 => address) public codeOwner;
    mapping(address => bytes32[]) internal _ownedCodes;

    struct Order { address buyer; uint256 productId; uint256 qty; address payToken; uint256 paid; bool exists; bool returned; }
    mapping(bytes32 => Order) public orders;   // refId => order
    mapping(bytes32 => bytes32[]) internal _orderCodes;
    uint256 public orderCounter;

    struct Listing { address seller; address payToken; uint256 price; bool active; }
    mapping(bytes32 => Listing) public listings; // codeId => listing

    struct ReturnReq { bytes32 refId; bytes32 codeId; address buyer; uint256 productId; uint256 paid; bool open; }
    ReturnReq[] public returnRequests;

    event MinerSet(address indexed miner, bool enabled, address indexed by);
    event PausedSet(bool paused, address indexed by);
    event TreasurySet(address indexed treasury, address indexed by);
    event HooksSet(address agentReward, address agentPoints, address agentLevel, address indexed by);
    event BannedSet(address indexed who, bool banned, address indexed by);
    event WhitelistEnabledSet(bool enabled, address indexed by);
    event WhitelistSet(address indexed who, bool allowed, address indexed by);
    event ProductCreated(uint256 indexed productId, string name, address indexed by);
    event ProductUpdated(uint256 indexed productId, address indexed by);
    event ProductActiveSet(uint256 indexed productId, bool active, address indexed by);
    event PriceSet(uint256 indexed productId, address indexed token, uint256 unitPrice, address indexed by);
    event TiersSet(uint256 indexed productId, uint256 count, address indexed by);
    event RewardCfgAdded(uint256 indexed productId, address indexed claim, uint8 mode, uint256 amountOrBps, address indexed by);
    event RewardCfgCleared(uint256 indexed productId, address indexed by);
    event CodesImported(uint256 indexed productId, uint256 count, address indexed by);
    event Purchased(bytes32 indexed refId, address indexed buyer, uint256 indexed productId, uint256 qty, address payToken, uint256 gross, uint256 net);
    event RebateHookFailed(bytes32 indexed refId);
    event ItemTransferred(bytes32 indexed codeId, address indexed from, address indexed to);
    event ItemListed(bytes32 indexed codeId, address indexed seller, address payToken, uint256 price);
    event ListingCancelled(bytes32 indexed codeId, address indexed seller);
    event ItemResold(bytes32 indexed codeId, address indexed seller, address indexed buyer, address payToken, uint256 price, uint256 fee);
    event ReturnRequested(uint256 indexed id, bytes32 indexed refId, address indexed buyer, uint256 productId);
    event ReturnApproved(uint256 indexed id, bytes32 indexed refId, address indexed buyer, uint256 refundAmount, address by);
    event ReturnRejected(uint256 indexed id, bytes32 indexed refId, address indexed by);
    event Withdrawn(address indexed token, address indexed to, uint256 amount, address indexed by);

    modifier onlyMiner() { require(isMiner[msg.sender], "GM: not miner"); _; }
    modifier whenNotPaused() { require(!paused, "GM: paused"); _; }

    constructor(address treasury_, address agentReward_, address agentPoints_, address agentLevel_, address[] memory miners_) {
        require(treasury_ != address(0), "GM: zero treasury");
        treasury = treasury_;
        agentReward = IAgentReward(agentReward_);
        agentPoints = IAgentPoints(agentPoints_);
        agentLevel = IAgentLevel(agentLevel_);
        uint256 n = miners_.length;
        require(n > 0 && n <= MAX_MINERS, "GM: miners 1..3");
        for (uint256 i = 0; i < n; i++) {
            address m = miners_[i];
            require(m != address(0), "GM: zero miner");
            if (!isMiner[m]) { isMiner[m] = true; minerCount++; emit MinerSet(m, true, msg.sender); }
        }
    }

    function _checkAccess(address a) internal view {
        require(!banned[a], "GM: banned");
        if (whitelistEnabled) require(whitelist[a], "GM: not whitelisted");
    }
    function _tierBps(uint256 productId, uint256 qty) internal view returns (uint256) {
        Tier[] storage t = _tiers[productId];
        uint256 bps = 10000;
        uint256 bestMin = 0;
        for (uint256 i = 0; i < t.length; i++) {
            if (qty >= t[i].minQty && t[i].minQty >= bestMin) { bestMin = t[i].minQty; bps = t[i].bps; }
        }
        return bps;
    }
    function _removeOwned(address owner_, bytes32 codeId) internal {
        bytes32[] storage arr = _ownedCodes[owner_];
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == codeId) { arr[i] = arr[arr.length - 1]; arr.pop(); break; }
        }
    }
    function _moveCode(bytes32 codeId, address from, address to) internal {
        _removeOwned(from, codeId);
        codeOwner[codeId] = to;
        _ownedCodes[to].push(codeId);
    }

    // ---------- purchase ----------
    function buy(uint256 productId, uint256 qty, address payToken) external whenNotPaused returns (bytes32 refId) {
        _checkAccess(msg.sender);
        Product storage p = products[productId];
        require(p.exists && p.active, "GM: product na");
        require(qty > 0 && qty >= p.minOrderQty, "GM: below MOQ");
        uint256 unit = price[productId][payToken];
        require(unit > 0, "GM: token not accepted");
        bytes32[] storage avail = _available[productId];
        require(avail.length >= qty, "GM: insufficient stock");

        uint256 gross = unit * qty;
        uint256 net = (gross * _tierBps(productId, qty)) / 10000;
        require(IERC20(payToken).transferFrom(msg.sender, address(this), net), "GM: pay fail");

        orderCounter++;
        refId = keccak256(abi.encode(block.chainid, productId, orderCounter));
        orders[refId] = Order(msg.sender, productId, qty, payToken, net, true, false);

        for (uint256 i = 0; i < qty; i++) {
            bytes32 codeId = avail[avail.length - 1];
            avail.pop();
            codeStatus[codeId] = 2;
            codeOwner[codeId] = msg.sender;
            _ownedCodes[msg.sender].push(codeId);
            _orderCodes[refId].push(codeId);
        }
        sold[productId] += qty;

        // direct per-product rewards (core deliverable)
        RewardCfg[] storage rc = _rewards[productId];
        for (uint256 i = 0; i < rc.length; i++) {
            uint256 amt = rc[i].mode == 0 ? rc[i].amountOrBps * qty : (net * rc[i].amountOrBps) / 10000;
            if (amt > 0) {
                IRewardClaim(rc[i].claim).addReward(msg.sender, amt, keccak256(abi.encode(refId, uint8(82), i)));
            }
        }

        // agent points + team points hooks (resilient)
        if (p.pointsPerUnit > 0 && address(agentPoints) != address(0)) {
            uint256 pts = p.pointsPerUnit * qty;
            try agentPoints.mint(msg.sender, pts, refId) {} catch {}
            if (p.feedTeamPoints && address(agentLevel) != address(0)) {
                try agentLevel.recordPoints(msg.sender, pts) {} catch {}
            }
        }

        // agent rebate distribution (resilient)
        if (address(agentReward) != address(0)) {
            try agentReward.onPurchase(msg.sender, productId, gross, net, payToken, refId) {}
            catch { emit RebateHookFailed(refId); }
        }

        emit Purchased(refId, msg.sender, productId, qty, payToken, gross, net);
    }

    // ---------- resale ----------
    function transferItem(bytes32 codeId, address to) external whenNotPaused {
        _checkAccess(msg.sender); _checkAccess(to);
        require(codeOwner[codeId] == msg.sender, "GM: not owner");
        require(codeStatus[codeId] == 2, "GM: not transferable");
        require(!listings[codeId].active, "GM: listed");
        _moveCode(codeId, msg.sender, to);
        emit ItemTransferred(codeId, msg.sender, to);
    }
    function listItem(bytes32 codeId, address payToken, uint256 priceAmount) external whenNotPaused {
        _checkAccess(msg.sender);
        require(codeOwner[codeId] == msg.sender, "GM: not owner");
        require(codeStatus[codeId] == 2, "GM: not sellable");
        require(payToken != address(0) && priceAmount > 0, "GM: bad listing");
        listings[codeId] = Listing(msg.sender, payToken, priceAmount, true);
        emit ItemListed(codeId, msg.sender, payToken, priceAmount);
    }
    function cancelListing(bytes32 codeId) external {
        Listing storage l = listings[codeId];
        require(l.active && l.seller == msg.sender, "GM: no listing");
        l.active = false;
        emit ListingCancelled(codeId, msg.sender);
    }
    function buyListed(bytes32 codeId) external whenNotPaused {
        _checkAccess(msg.sender);
        Listing storage l = listings[codeId];
        require(l.active, "GM: not listed");
        require(codeOwner[codeId] == l.seller, "GM: stale listing");
        require(msg.sender != l.seller, "GM: self buy");
        uint256 pid = codeProduct[codeId];
        uint256 fee = (l.price * products[pid].resaleFeeBps) / 10000;
        uint256 toSeller = l.price - fee;
        require(IERC20(l.payToken).transferFrom(msg.sender, l.seller, toSeller), "GM: pay seller fail");
        if (fee > 0) require(IERC20(l.payToken).transferFrom(msg.sender, treasury, fee), "GM: pay fee fail");
        l.active = false;
        _moveCode(codeId, l.seller, msg.sender);
        emit ItemResold(codeId, l.seller, msg.sender, l.payToken, l.price, fee);
    }

    // ---------- returns (reviewed) ----------
    function returnRequest(bytes32 refId, bytes32 codeId) external returns (uint256 id) {
        Order storage o = orders[refId];
        require(o.exists && !o.returned, "GM: bad order");
        require(o.buyer == msg.sender, "GM: not buyer");
        require(codeOwner[codeId] == msg.sender && codeProduct[codeId] == o.productId, "GM: bad code");
        id = returnRequests.length;
        returnRequests.push(ReturnReq(refId, codeId, msg.sender, o.productId, o.paid, true));
        emit ReturnRequested(id, refId, msg.sender, o.productId);
    }
    /// @notice miner reviews AFTER confirming any claimed rewards were returned
    ///         to their RewardClaim (returnReward). Unclaimed rebates are
    ///         auto-clawed via AgentReward.revokeOrder. refundAmount is miner-set.
    function approveReturn(uint256 id, uint256 refundAmount) external onlyMiner {
        ReturnReq storage r = returnRequests[id];
        require(r.open, "GM: closed");
        r.open = false;
        Order storage o = orders[r.refId];
        o.returned = true;
        if (address(agentReward) != address(0)) { try agentReward.revokeOrder(r.refId) {} catch {} }
        address holder = codeOwner[r.codeId];
        _removeOwned(holder, r.codeId);
        codeOwner[r.codeId] = address(0);
        codeStatus[r.codeId] = 3;
        if (refundAmount > 0) require(IERC20(o.payToken).transfer(r.buyer, refundAmount), "GM: refund fail");
        emit ReturnApproved(id, r.refId, r.buyer, refundAmount, msg.sender);
    }
    function rejectReturn(uint256 id) external onlyMiner {
        ReturnReq storage r = returnRequests[id];
        require(r.open, "GM: closed");
        r.open = false;
        emit ReturnRejected(id, r.refId, msg.sender);
    }

    // ---------- config (miner) ----------
    function createProduct(string calldata name, uint256 minOrderQty, bool secretCode, uint256 resaleFeeBps, uint256 pointsPerUnit, bool feedTeamPoints) external onlyMiner returns (uint256 productId) {
        require(resaleFeeBps <= 10000, "GM: bad fee");
        productCount++;
        productId = productCount;
        products[productId] = Product(true, true, secretCode, minOrderQty, resaleFeeBps, pointsPerUnit, feedTeamPoints, name);
        emit ProductCreated(productId, name, msg.sender);
    }
    function updateProduct(uint256 productId, uint256 minOrderQty, bool secretCode, uint256 resaleFeeBps, uint256 pointsPerUnit, bool feedTeamPoints) external onlyMiner {
        Product storage p = products[productId];
        require(p.exists, "GM: no product");
        require(resaleFeeBps <= 10000, "GM: bad fee");
        p.minOrderQty = minOrderQty; p.secretCode = secretCode; p.resaleFeeBps = resaleFeeBps;
        p.pointsPerUnit = pointsPerUnit; p.feedTeamPoints = feedTeamPoints;
        emit ProductUpdated(productId, msg.sender);
    }
    function setProductActive(uint256 productId, bool active) external onlyMiner {
        require(products[productId].exists, "GM: no product");
        products[productId].active = active;
        emit ProductActiveSet(productId, active, msg.sender);
    }
    function setPrice(uint256 productId, address token, uint256 unitPrice) external onlyMiner {
        require(products[productId].exists, "GM: no product");
        require(token != address(0), "GM: zero token");
        price[productId][token] = unitPrice; // 0 to disable token
        emit PriceSet(productId, token, unitPrice, msg.sender);
    }
    function setTiers(uint256 productId, uint256[] calldata minQtys, uint256[] calldata bpsList) external onlyMiner {
        require(products[productId].exists, "GM: no product");
        require(minQtys.length == bpsList.length, "GM: len");
        delete _tiers[productId];
        for (uint256 i = 0; i < minQtys.length; i++) {
            require(bpsList[i] > 0 && bpsList[i] <= 10000, "GM: bad bps");
            _tiers[productId].push(Tier(minQtys[i], bpsList[i]));
        }
        emit TiersSet(productId, minQtys.length, msg.sender);
    }
    function addRewardCfg(uint256 productId, address claim, uint8 mode, uint256 amountOrBps) external onlyMiner {
        require(products[productId].exists, "GM: no product");
        require(claim != address(0), "GM: zero claim");
        require(mode <= 1, "GM: bad mode");
        if (mode == 1) require(amountOrBps <= 10000, "GM: bps>100%");
        _rewards[productId].push(RewardCfg(claim, mode, amountOrBps));
        emit RewardCfgAdded(productId, claim, mode, amountOrBps, msg.sender);
    }
    function clearRewardCfg(uint256 productId) external onlyMiner {
        delete _rewards[productId];
        emit RewardCfgCleared(productId, msg.sender);
    }
    function importCodes(uint256 productId, bytes32[] calldata codeIds) external onlyMiner {
        require(products[productId].exists, "GM: no product");
        for (uint256 i = 0; i < codeIds.length; i++) {
            bytes32 c = codeIds[i];
            require(codeStatus[c] == 0, "GM: dup code");
            codeStatus[c] = 1;
            codeProduct[c] = productId;
            _available[productId].push(c);
        }
        emit CodesImported(productId, codeIds.length, msg.sender);
    }
    function setBanned(address who, bool isBanned) external onlyMiner { banned[who] = isBanned; emit BannedSet(who, isBanned, msg.sender); }
    function setWhitelistEnabled(bool enabled) external onlyMiner { whitelistEnabled = enabled; emit WhitelistEnabledSet(enabled, msg.sender); }
    function setWhitelist(address who, bool allowed) external onlyMiner { whitelist[who] = allowed; emit WhitelistSet(who, allowed, msg.sender); }
    function setWhitelistBatch(address[] calldata who, bool allowed) external onlyMiner {
        for (uint256 i = 0; i < who.length; i++) { whitelist[who[i]] = allowed; emit WhitelistSet(who[i], allowed, msg.sender); }
    }
    function setHooks(address agentReward_, address agentPoints_, address agentLevel_) external onlyMiner {
        agentReward = IAgentReward(agentReward_);
        agentPoints = IAgentPoints(agentPoints_);
        agentLevel = IAgentLevel(agentLevel_);
        emit HooksSet(agentReward_, agentPoints_, agentLevel_, msg.sender);
    }
    function setTreasury(address t) external onlyMiner { require(t != address(0), "GM: zero"); treasury = t; emit TreasurySet(t, msg.sender); }
    function withdraw(address token, address to, uint256 amount) external onlyMiner {
        require(to != address(0), "GM: zero to");
        require(IERC20(token).transfer(to, amount), "GM: withdraw fail");
        emit Withdrawn(token, to, amount, msg.sender);
    }
    function setMiner(address miner, bool enabled) external onlyMiner {
        require(miner != address(0), "GM: zero miner");
        if (enabled) {
            require(!isMiner[miner], "GM: already miner");
            require(minerCount < MAX_MINERS, "GM: max miners");
            isMiner[miner] = true; minerCount++;
        } else {
            require(isMiner[miner], "GM: not miner");
            require(minerCount > 1, "GM: need >=1 miner");
            isMiner[miner] = false; minerCount--;
        }
        emit MinerSet(miner, enabled, msg.sender);
    }
    function setPaused(bool p) external onlyMiner { paused = p; emit PausedSet(p, msg.sender); }

    // ---------- views ----------
    function availableStock(uint256 productId) external view returns (uint256) { return _available[productId].length; }
    function tiersOf(uint256 productId) external view returns (Tier[] memory) { return _tiers[productId]; }
    function rewardsOf(uint256 productId) external view returns (RewardCfg[] memory) { return _rewards[productId]; }
    function quote(uint256 productId, uint256 qty, address payToken) external view returns (uint256 gross, uint256 net) {
        uint256 unit = price[productId][payToken];
        gross = unit * qty;
        net = (gross * _tierBps(productId, qty)) / 10000;
    }
    function myCodes() external view returns (bytes32[] memory) { return _ownedCodes[msg.sender]; }
    function ownedCodesOf(address a) external view returns (bytes32[] memory) {
        require(msg.sender == a || isMiner[msg.sender], "GM: gated");
        return _ownedCodes[a];
    }
    function orderCodes(bytes32 refId) external view returns (bytes32[] memory) { return _orderCodes[refId]; }
    function productCodes(uint256 productId) external view returns (bytes32[] memory) {
        require(!products[productId].secretCode || isMiner[msg.sender], "GM: secret");
        return _available[productId];
    }
    function returnRequestCount() external view returns (uint256) { return returnRequests.length; }
    function getReturnRequest(uint256 id) external view returns (address buyer, uint256 productId, address payToken, uint256 paid, bool open) {
        ReturnReq storage r = returnRequests[id];
        return (r.buyer, r.productId, orders[r.refId].payToken, r.paid, r.open);
    }
}
```

## 三、完整 ABI

### 3.1 ethers 人类可读

```jsx
const GOODSMARKET_ABI = [
  "constructor(address treasury_, address agentReward_, address agentPoints_, address agentLevel_, address[] miners_)",
  // core reads
  "function treasury() view returns (address)",
  "function paused() view returns (bool)",
  "function agentReward() view returns (address)",
  "function agentPoints() view returns (address)",
  "function agentLevel() view returns (address)",
  "function isMiner(address) view returns (bool)",
  "function minerCount() view returns (uint256)",
  "function banned(address) view returns (bool)",
  "function whitelistEnabled() view returns (bool)",
  "function whitelist(address) view returns (bool)",
  "function productCount() view returns (uint256)",
  "function products(uint256) view returns (bool exists, bool active, bool secretCode, uint256 minOrderQty, uint256 resaleFeeBps, uint256 pointsPerUnit, bool feedTeamPoints, string name)",
  "function price(uint256, address) view returns (uint256)",
  "function sold(uint256) view returns (uint256)",
  "function codeStatus(bytes32) view returns (uint8)",
  "function codeProduct(bytes32) view returns (uint256)",
  "function codeOwner(bytes32) view returns (address)",
  "function orders(bytes32) view returns (address buyer, uint256 productId, uint256 qty, address payToken, uint256 paid, bool exists, bool returned)",
  "function orderCounter() view returns (uint256)",
  "function listings(bytes32) view returns (address seller, address payToken, uint256 price, bool active)",
  "function returnRequests(uint256) view returns (bytes32 refId, bytes32 codeId, address buyer, uint256 productId, uint256 paid, bool open)",
  // aggregate views
  "function availableStock(uint256 productId) view returns (uint256)",
  "function tiersOf(uint256 productId) view returns (tuple(uint256 minQty, uint256 bps)[])",
  "function rewardsOf(uint256 productId) view returns (tuple(address claim, uint8 mode, uint256 amountOrBps)[])",
  "function quote(uint256 productId, uint256 qty, address payToken) view returns (uint256 gross, uint256 net)",
  "function myCodes() view returns (bytes32[])",
  "function ownedCodesOf(address a) view returns (bytes32[])",
  "function orderCodes(bytes32 refId) view returns (bytes32[])",
  "function productCodes(uint256 productId) view returns (bytes32[])",
  "function returnRequestCount() view returns (uint256)",
  "function getReturnRequest(uint256 id) view returns (address buyer, uint256 productId, address payToken, uint256 paid, bool open)",
  // user writes
  "function buy(uint256 productId, uint256 qty, address payToken) returns (bytes32 refId)",
  "function transferItem(bytes32 codeId, address to)",
  "function listItem(bytes32 codeId, address payToken, uint256 priceAmount)",
  "function cancelListing(bytes32 codeId)",
  "function buyListed(bytes32 codeId)",
  "function returnRequest(bytes32 refId, bytes32 codeId) returns (uint256 id)",
  // miner writes
  "function approveReturn(uint256 id, uint256 refundAmount)",
  "function rejectReturn(uint256 id)",
  "function createProduct(string name, uint256 minOrderQty, bool secretCode, uint256 resaleFeeBps, uint256 pointsPerUnit, bool feedTeamPoints) returns (uint256 productId)",
  "function updateProduct(uint256 productId, uint256 minOrderQty, bool secretCode, uint256 resaleFeeBps, uint256 pointsPerUnit, bool feedTeamPoints)",
  "function setProductActive(uint256 productId, bool active)",
  "function setPrice(uint256 productId, address token, uint256 unitPrice)",
  "function setTiers(uint256 productId, uint256[] minQtys, uint256[] bpsList)",
  "function addRewardCfg(uint256 productId, address claim, uint8 mode, uint256 amountOrBps)",
  "function clearRewardCfg(uint256 productId)",
  "function importCodes(uint256 productId, bytes32[] codeIds)",
  "function setBanned(address who, bool isBanned)",
  "function setWhitelistEnabled(bool enabled)",
  "function setWhitelist(address who, bool allowed)",
  "function setWhitelistBatch(address[] who, bool allowed)",
  "function setHooks(address agentReward_, address agentPoints_, address agentLevel_)",
  "function setTreasury(address t)",
  "function withdraw(address token, address to, uint256 amount)",
  "function setMiner(address miner, bool enabled)",
  "function setPaused(bool p)",
  // events
  "event Purchased(bytes32 indexed refId, address indexed buyer, uint256 indexed productId, uint256 qty, address payToken, uint256 gross, uint256 net)",
  "event RebateHookFailed(bytes32 indexed refId)",
  "event ItemTransferred(bytes32 indexed codeId, address indexed from, address indexed to)",
  "event ItemListed(bytes32 indexed codeId, address indexed seller, address payToken, uint256 price)",
  "event ListingCancelled(bytes32 indexed codeId, address indexed seller)",
  "event ItemResold(bytes32 indexed codeId, address indexed seller, address indexed buyer, address payToken, uint256 price, uint256 fee)",
  "event ReturnRequested(uint256 indexed id, bytes32 indexed refId, address indexed buyer, uint256 productId)",
  "event ReturnApproved(uint256 indexed id, bytes32 indexed refId, address indexed buyer, uint256 refundAmount, address by)",
  "event ReturnRejected(uint256 indexed id, bytes32 indexed refId, address indexed by)",
  "event ProductCreated(uint256 indexed productId, string name, address indexed by)",
  "event PriceSet(uint256 indexed productId, address indexed token, uint256 unitPrice, address indexed by)",
  "event CodesImported(uint256 indexed productId, uint256 count, address indexed by)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount, address indexed by)"
];
```

### 3.2 JSON ABI（核心条目）

```json
[
  {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"treasury_","type":"address"},{"name":"agentReward_","type":"address"},{"name":"agentPoints_","type":"address"},{"name":"agentLevel_","type":"address"},{"name":"miners_","type":"address[]"}]},
  {"type":"function","name":"buy","stateMutability":"nonpayable","inputs":[{"name":"productId","type":"uint256"},{"name":"qty","type":"uint256"},{"name":"payToken","type":"address"}],"outputs":[{"name":"refId","type":"bytes32"}]},
  {"type":"function","name":"quote","stateMutability":"view","inputs":[{"name":"productId","type":"uint256"},{"name":"qty","type":"uint256"},{"name":"payToken","type":"address"}],"outputs":[{"name":"gross","type":"uint256"},{"name":"net","type":"uint256"}]},
  {"type":"function","name":"transferItem","stateMutability":"nonpayable","inputs":[{"name":"codeId","type":"bytes32"},{"name":"to","type":"address"}],"outputs":[]},
  {"type":"function","name":"listItem","stateMutability":"nonpayable","inputs":[{"name":"codeId","type":"bytes32"},{"name":"payToken","type":"address"},{"name":"priceAmount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"buyListed","stateMutability":"nonpayable","inputs":[{"name":"codeId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"cancelListing","stateMutability":"nonpayable","inputs":[{"name":"codeId","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"returnRequest","stateMutability":"nonpayable","inputs":[{"name":"refId","type":"bytes32"},{"name":"codeId","type":"bytes32"}],"outputs":[{"name":"id","type":"uint256"}]},
  {"type":"function","name":"approveReturn","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},{"name":"refundAmount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"rejectReturn","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"getReturnRequest","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"name":"buyer","type":"address"},{"name":"productId","type":"uint256"},{"name":"payToken","type":"address"},{"name":"paid","type":"uint256"},{"name":"open","type":"bool"}]},
  {"type":"function","name":"createProduct","stateMutability":"nonpayable","inputs":[{"name":"name","type":"string"},{"name":"minOrderQty","type":"uint256"},{"name":"secretCode","type":"bool"},{"name":"resaleFeeBps","type":"uint256"},{"name":"pointsPerUnit","type":"uint256"},{"name":"feedTeamPoints","type":"bool"}],"outputs":[{"name":"productId","type":"uint256"}]},
  {"type":"function","name":"setPrice","stateMutability":"nonpayable","inputs":[{"name":"productId","type":"uint256"},{"name":"token","type":"address"},{"name":"unitPrice","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setTiers","stateMutability":"nonpayable","inputs":[{"name":"productId","type":"uint256"},{"name":"minQtys","type":"uint256[]"},{"name":"bpsList","type":"uint256[]"}],"outputs":[]},
  {"type":"function","name":"addRewardCfg","stateMutability":"nonpayable","inputs":[{"name":"productId","type":"uint256"},{"name":"claim","type":"address"},{"name":"mode","type":"uint8"},{"name":"amountOrBps","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"importCodes","stateMutability":"nonpayable","inputs":[{"name":"productId","type":"uint256"},{"name":"codeIds","type":"bytes32[]"}],"outputs":[]},
  {"type":"function","name":"setHooks","stateMutability":"nonpayable","inputs":[{"name":"agentReward_","type":"address"},{"name":"agentPoints_","type":"address"},{"name":"agentLevel_","type":"address"}],"outputs":[]},
  {"type":"function","name":"setBanned","stateMutability":"nonpayable","inputs":[{"name":"who","type":"address"},{"name":"isBanned","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setWhitelistEnabled","stateMutability":"nonpayable","inputs":[{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setWhitelistBatch","stateMutability":"nonpayable","inputs":[{"name":"who","type":"address[]"},{"name":"allowed","type":"bool"}],"outputs":[]},
  {"type":"function","name":"withdraw","stateMutability":"nonpayable","inputs":[{"name":"token","type":"address"},{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"event","name":"Purchased","anonymous":false,"inputs":[{"name":"refId","type":"bytes32","indexed":true},{"name":"buyer","type":"address","indexed":true},{"name":"productId","type":"uint256","indexed":true},{"name":"qty","type":"uint256","indexed":false},{"name":"payToken","type":"address","indexed":false},{"name":"gross","type":"uint256","indexed":false},{"name":"net","type":"uint256","indexed":false}]},
  {"type":"event","name":"ItemResold","anonymous":false,"inputs":[{"name":"codeId","type":"bytes32","indexed":true},{"name":"seller","type":"address","indexed":true},{"name":"buyer","type":"address","indexed":true},{"name":"payToken","type":"address","indexed":false},{"name":"price","type":"uint256","indexed":false},{"name":"fee","type":"uint256","indexed":false}]},
  {"type":"event","name":"ReturnApproved","anonymous":false,"inputs":[{"name":"id","type":"uint256","indexed":true},{"name":"refId","type":"bytes32","indexed":true},{"name":"buyer","type":"address","indexed":true},{"name":"refundAmount","type":"uint256","indexed":false},{"name":"by","type":"address","indexed":false}]}
]
```

> 完整 JSON ABI 由 `forge inspect GoodsMarket abi` 生成；上表列出前端/admin 最常用条目。

## 四、函数参数使用说明

| 函数                                                         | 谁可调              | 参数                                                            | 说明 / 示例                                                       |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `buy(productId, qty, payToken)`                            | 非黑名单（白名单开时需在白名单） | productId；qty≥MOQ；payToken                                    | 需先 `approve` 本合约；按阶梯折扣付 net；出库 qty 个唯一码；联动三合约                 |
| `quote(productId, qty, payToken)`                          | 任何人（view）        | 同上                                                            | 预览 gross/net（含折扣）                                             |
| `transferItem(codeId, to)`                                 | 码持有人             | codeId；to                                                     | 直转/赠送（未挂单时），无费                                                |
| `listItem / buyListed / cancelListing`                     | 持有人 / 买家 / 持有人   | codeId（+payToken/price）                                       | 挂单回购；`resaleFeeBps` 抽成入 treasury，余额给卖家                        |
| `returnRequest(refId, codeId)`                             | 买家               | refId=订单；codeId=待退码                                           | 发起退货申请（待 miner 审核）                                            |
| `approveReturn(id, refundAmount)`                          | 仅 miner          | id；refundAmount=直取退款金额                                        | **先确认已领奖励已 returnReward 退回**；本函数自动 revokeOrder 回收未领返利、回收码、退款  |
| `getReturnRequest(id)`                                     | 任何人（view）        | id                                                            | 返回 地址-产品-支付币-金额-状态（miner 直取）                                  |
| `createProduct / updateProduct / setProductActive`         | 仅 miner          | name/MOQ/secretCode/resaleFeeBps/pointsPerUnit/feedTeamPoints | 建/改商品与上下架                                                     |
| `setPrice(productId, token, unitPrice)`                    | 仅 miner          | token；unitPrice（0=停用该币）                                       | 多币定价                                                          |
| `setTiers(productId, minQtys[], bpsList[])`                | 仅 miner          | bps=支付原价比例（≤10000）                                            | 例：`([10,50,100],[7000,6000,5000])` 即 ≥10件70%/≥50件60%/≥100件50% |
| `addRewardCfg / clearRewardCfg`                            | 仅 miner          | claim；mode 0 固定×qty / 1 成交×bps；amountOrBps                    | 购后直写奖励进指定 RewardClaim（需在该 claim 授本合约为 rewarder）               |
| `importCodes(productId, bytes32[])`                        | 仅 miner          | codeIds（建议存哈希）                                                | 导入库存；500 码 = 500 库存                                           |
| `setBanned / setWhitelistEnabled / setWhitelist(Batch)`    | 仅 miner          | 见 ABI                                                         | 全功能黑白名单                                                       |
| `setHooks / setTreasury / withdraw / setMiner / setPaused` | 仅 miner          | 见 ABI                                                         | 联动合约、提利、运维                                                    |

## 五、SH 部署脚本（[goodsmarket-deploy.sh](http://goodsmarket-deploy.sh)）

```bash
#!/usr/bin/env bash
set -euo pipefail

# ===== GoodsMarket 部署（防串链）=====
# 用法: PRIVATE_KEY=0x.. TREASURY=0x.. AGENTREWARD=0x.. AGENTPOINTS=0x.. AGENTLEVEL=0x.. ./goodsmarket-deploy.sh [r9|obt|qdt]
CHAIN_KEY="${1:-r9}"

case "${CHAIN_KEY}" in
  r9)  RPC="${RPC:-<http://47.86.44.43:41546>}"; EXPECT_CHAINID=555555555 ;;
  obt) RPC="${RPC:-<http://47.86.44.43:39546>}"; EXPECT_CHAINID=1008611 ;;
  qdt) RPC="${RPC:-<http://47.86.44.43:40546>}"; EXPECT_CHAINID=88888888 ;;
  *) echo "unknown chainKey: ${CHAIN_KEY}"; exit 1 ;;
esac

: "${PRIVATE_KEY:?need PRIVATE_KEY}"
: "${TREASURY:?need TREASURY}"
DEPLOYER="${DEPLOYER:-0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996}"
MINERS="${MINERS:-${DEPLOYER}}"
MINERS_ARR="[$(echo "${MINERS}" | tr -d ' ')]"
# 联动合约可先传 0x0，事后 setHooks——但推荐先部署好再传
AGENTREWARD="${AGENTREWARD:-0x0000000000000000000000000000000000000000}"
AGENTPOINTS="${AGENTPOINTS:-0x0000000000000000000000000000000000000000}"
AGENTLEVEL="${AGENTLEVEL:-0x0000000000000000000000000000000000000000}"

# ---- 防串链 ----
ACTUAL_CHAINID="$(cast chain-id --rpc-url "${RPC}")"
[ "${ACTUAL_CHAINID}" = "${EXPECT_CHAINID}" ] || { echo "❌ chainId 不符: 期望 ${EXPECT_CHAINID}, 实测 ${ACTUAL_CHAINID}"; exit 1; }
echo "✅ chainId ${ACTUAL_CHAINID}"

ADDR="$(forge create \
  --rpc-url "${RPC}" --private-key "${PRIVATE_KEY}" \
  --evm-version shanghai --optimize --optimizer-runs 200 --legacy \
  src/GoodsMarket.sol:GoodsMarket \
  --constructor-args "${TREASURY}" "${AGENTREWARD}" "${AGENTPOINTS}" "${AGENTLEVEL}" "${MINERS_ARR}" \
  | grep 'Deployed to:' | awk '{print $3}')"
echo "GoodsMarket deployed: ${ADDR}"

# ---- 自检 ----
echo "treasury    = $(cast call "${ADDR}" 'treasury()(address)' --rpc-url "${RPC}")"
echo "minerCount  = $(cast call "${ADDR}" 'minerCount()(uint256)' --rpc-url "${RPC}")"
echo "agentReward = $(cast call "${ADDR}" 'agentReward()(address)' --rpc-url "${RPC}")"

echo "GOODSMARKET_${CHAIN_KEY}=${ADDR}" >> deploy.out
# ---- 部署后关键授权（双向）----
# 1) AgentReward.setRewarder(GoodsMarket, max)     — 允许触发返利
# 2) AgentPoints.setPointsSource(GoodsMarket, max) — 允许 mint 积分
# 3) AgentLevel.setFeeder(GoodsMarket, max)        — 允许喂团队积分
# 4) 每个直写奖励 RewardClaim.setRewarder(GoodsMarket, max)
# 5) 本合约：createProduct → setPrice → setTiers → addRewardCfg → importCodes
```

## 六、完整部署参数

| 参数                                             | 值 / 来源                                                                                                                 | 说明                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| solidity / evm_version                         | `^0.8.24` / `shanghai`                                                                                                 | 统一                                 |
| 构造 `treasury_`                                 | 团队收款/抑制地址（提利目标）                                                                                                        | 必填非零                               |
| 构造 `agentReward_ / agentPoints_ / agentLevel_` | 本体系第 4 / 1 / 3 份地址（可先 0x0 事后 setHooks）                                                                                 | 联动钩子                               |
| 构造 `miners_`                                   | `[0xcc5e27455Cd6914A132Cea2d460E0301e1BB9996]`                                                                         | 上限 3                               |
| 双向授权（关键）                                       | AgentReward.setRewarder / AgentPoints.setPointsSource / AgentLevel.setFeeder / RewardClaim.setRewarder 均指向 GoodsMarket | 否则购买时钩子静默失败（try/catch）或直写奖励 revert |
| 商品初始化                                          | createProduct → setPrice → setTiers → addRewardCfg → importCodes                                                       | 折扣例 `[7000,6000,5000]`             |

<aside>  
🔗

**回填位**：`GOODSMARKET_R9 = 0x____`。地址写回 [今日 TODO](https://app.notion.com/p/d64381f24688488d8fef1ff8c62784ce?pvs=21) F 宪法登记 + 本体系总纲。双向授权完成后才能跑通购买→返利/积分/团队积分全链路。

</aside>

## 七、r9-admin 挂载要点

- 新增类型 **GoodsMarket**（分类 tab：中文「商城」+ 英文小字 GoodsMarket）。
- 商品管理：`createProduct/updateProduct/setProductActive`、`setPrice`（多币行）、`setTiers`（阶梯编辑器）、`addRewardCfg/clearRewardCfg`、`importCodes`（批量粘贴/上传）。
- 库存/订单：`availableStock`、`sold`、`orders(refId)`+`orderCodes`、`getReturnRequest`+遗历 `returnRequestCount`。
- 用户面板：`quote`→`approve`→`buy`；`myCodes`；`transferItem`；`listItem/buyListed/cancelListing`；`returnRequest`。
- Miner 面板：`approveReturn/rejectReturn`（展示 地址-产品-金额）、`setBanned/setWhitelist*`、`setHooks/setTreasury/withdraw/setMiner/setPaused`。
- 全局 `_gmAddr` 变量避免 onclick 嵌套引号。
