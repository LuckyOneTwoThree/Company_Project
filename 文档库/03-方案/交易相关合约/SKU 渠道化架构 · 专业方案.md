# SKU 渠道化架构 · 专业方案（商品/短号二级流转拆分 · 2026-07-21）

<aside>  
🧭

**结论先行（逐条回答你的疑问）**

1. **转售逻辑内嵌在 GoodsMarket / ShortNumRegistry 里不合适**——你的判断正确。交易逻辑 × 每个商品合约 = 重复实现、双份审计、口径漂移，而且每加一种获得方式就要每份合约再写一遍。
2. **SKU 的「获得方式」应拆成独立渠道合约，且不止一种**——赠送/一口价/拍卖/限时交易所/租赁/集邮挖矿/拆份各一个渠道合约，**全部商品共用**。
3. **短号买卖没有订单记录**——用统一台账合约 TradeLedger 解决：一切获得方式（含一级购买）都写同一张链上订单表。

**P0 已完成（2026-07-21）**：GoodsMarket（v2.1）与 ShortNumRegistry（v4 基线）均已回退到无转卖版本（转卖/挂单/拍卖代码整体删除）。

</aside>

## 一、概念模型（先钉死名词）

| 概念          | GoodsMarket            | ShortNumRegistry           |
| ----------- | ---------------------- | -------------------------- |
| 商品（≈一个资产合约） | 一个商城合约（内含多个 productId） | 短号集合合约（整份=一个商品）            |
| SKU         | 一个唯一码 codeId（bytes32）  | 一个短号，key=keccak256(number) |
| 一级销售        | buy（多币价/折扣阶梯）          | buy / buyUnits（折扣/白名单）     |
| 所有权标记       | codeOwner[codeId]      | _records[key].owner        |

**资产层定义（与你的描述一致）**：商品合约 = 该商品的全部基础属性 + 初始化状态 + **除转卖赠送以外的所有功能**（一级销售、续费、黑白名单、暂停、到期、奖励联动）+ 所有权登记（ownerOf）。SKU 被某链上地址标记所有即「得到」；**怎么得到**属于渠道层，不属于资产层。

## 二、目标架构：三层拆分

```
资产层  GoodsMarket · ShortNumRegistry · 未来任何商品合约（各自一份，统一实现 ISkuRegistry 接口）
        └ 基础属性 + 初始化 + 一级销售(折扣/白名单/黑名单/暂停/到期) + 所有权登记
渠道层  GiftChannel(有偿/无偿赠送) · FixedPriceMarket(一口价) · AuctionHouse(个人/系统拍卖)
        · TimedExchange(限时动态价交易所) · RentalChannel(租赁) · MiningClaim(集邮挖矿) · FractionalVault(拆份永续)
        └ 每种获得方式一个合约，服务所有商品；miner 只管渠道启停（默认关），交易配置由用户按单自选
台账层  TradeLedger（统一订单记录：orderId · skuId · 商品合约 · 买卖双方 · 币 · 价 · 渠道 · 时间）
```

- **权限分层沿用 2026-07-21 定案**：miner 只管「渠道开关」（默认关；关停只禁新单，存量可撤/可结算，防托管资金卡死）；一口价或拍卖、价格、结算币、谁付手续费等全由用户挂单时自选；买方按卖方配置付费，**货款直付卖家钱包**（拍卖为合约托管、结算时转卖家），合约不截留。
- **奖励铁律不变**：只有资产层一级购买（buy/buyUnits）触发 _payReward / onPurchase；一切渠道流水一律不发佣。

### 2.1 资产层最小接口 ISkuRegistry（无转卖基线上补的钩子）

```solidity
interface ISkuRegistry {
    function skuOwner(bytes32 skuId) external view returns (address);
    function skuActive(bytes32 skuId) external view returns (bool);          // 到期/释放判断
    function channelTransfer(bytes32 skuId, address from, address to) external; // onlyChannel 过户
    function lockSku(bytes32 skuId) external;    // onlyChannel：挂单/托管锁定（替代原内嵌 ListedLocked）
    function unlockSku(bytes32 skuId) external;
}
```

- **skuId**：短号=keccak256(number)（现有 key，零迁移）；商品=现有 codeId。
- **channelTransfer 复用 v3.3 过户语义**：hasFree 随号走、清转出方默认号、接收方首号自动写默认、上下级关系不动。
- **渠道授权**：miner 调 `setChannel(addr, enabled, validUntil)`（白名单+时窗，复用 RewardClaim.setRewarder 范式）；吊销即全网停用，单点熔断。
- **删号/到期释放**：资产层释放前回调渠道 forceClose（或渠道结算时自查 skuActive），托管款可退。

### 2.2 你列的获得方式 → 渠道合约映射

| 获得方式              | 渠道合约             | 关键机制                                                 | 优先级              |
| ----------------- | ---------------- | ---------------------------------------------------- | ---------------- |
| 有偿赠送 / 系统无偿赠送活动   | GiftChannel      | 有偿=发起人付手续费+GAS（沿现 transfer 语义）；系统赠送=miner/活动合约批量发    | P1               |
| 接受别人一口价转卖         | FixedPriceMarket | 挂单配置全由卖家自选；货款 transferFrom(买家→卖家) 直付                 | P1               |
| 个人拍卖 / 系统拍卖       | AuctionHouse     | 限时最高价；出价托管、自动退前一出价、到期任何人结算；系统拍卖=卖家为 treasury         | P2               |
| 有交割期限动态价格交易所      | TimedExchange    | 荷兰拍/时间函数定价，到期交割                                      | P3               |
| NFT 集邮挖矿获得        | MiningClaim      | 集齐条件验证后 channelTransfer/铸新 SKU；依赖集邮资产定义              | P3               |
| 租赁获得              | RentalChannel    | 只给「使用权」（userOf/expires，ERC-4907 语义），所有权不动，到期自动回收     | P3               |
| 拆 2000 万份永续合约交易份额 | FractionalVault  | SKU 锁进金库→发 ERC20 份额；**本质是发行金融衍生品**：需预言机/资金费率/清算，风险最高 | P4（建议独立立项+审计，暂缓） |

## 三、统一订单台账 TradeLedger（解决「没有订单记录」）

```solidity
contract TradeLedger {
    struct TradeOrder {
        bytes32 skuId; address registry;   // 哪个商品合约的哪个 SKU
        uint8 channelId;                   // 0=PRIMARY 一级购买 / 1=赠送 / 2=一口价 / 3=拍卖 / ...
        address seller; address buyer; address payToken; uint256 price; uint64 time;
    }
    // recordOrder(...) onlyChannel；orderId = keccak(channelId, skuId, nonce)
    // ordersOfSku(skuId) / ordersOfUser(addr) 分页查询 + OrderRecorded 事件
}
```

- 每个渠道成交必写一条；**一级购买（buy/buyUnits）也写**（channelId=0）→ 所有获得方式统一有单。
- 退货/撤销：记反向单（冲销），与 RewardClaim / revokeOrder 口径对齐。
- 链下查询沿用 ShortNumIndexer 范式监听 OrderRecorded 派生索引表。

## 四、为什么不直接用 NFT（ERC-721）

| 方案                          | 优势                                                        | 劣势                               |
| --------------------------- | --------------------------------------------------------- | -------------------------------- |
| **A · 自建 ISkuRegistry（推荐）** | 改动小、与已部署 v3.3 兼容；无 approve 钓鱼面；短号过户附带语义（hasFree/默认号）可完整保留 | 不兼容现成 NFT 市场                     |
| B · 每 SKU 铸 ERC-721         | 生态现成（外部市场/钱包直接支持）                                         | 双份所有权状态要同步；迁移成本大；721 标准塞不下短号附带语义 |

**定案建议：A**。将来若要接外部 NFT 市场，再加一个 721 Wrapper（包装器）合约即可，不影响本架构。

## 五、无转卖基线还要做的调整（回答「去掉转售的版本要不要优化」）

1. **ShortNumRegistry（v4 基线 = v3.3 + 白名单 + 折扣）**：补 ISkuRegistry 五函数 + `setChannel` + 锁定检查（transfer/释放时查 SkuLocked）；`transfer`（赠送）暂保留（已部署语义），GiftChannel 上线后加开关停用。
2. **GoodsMarket（v2.1 基线）**：同样补 ISkuRegistry + setChannel；现有 orders 结构保留（一级订单），二级订单走 TradeLedger。
3. 两资产合约的 buy 同笔 try 写 TradeLedger（PRIMARY 单，best-effort 不阻断购买）。
4. **admin 运维台**：渠道合约各自新面板（miner 区=渠道开关，用户区=挂单/购买/出价/结算）；资产合约面板只留资产层功能（已回退）。

## 六、分期路线（待你确认后输出开发 TODOLIST + 代码）

| 阶段  | 内容                                                                                                | 状态                     |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| P0  | 两合约回退无转卖基线 + 运维台同步                                                                                | ✅ 已完成（2026-07-21）      |
| P1  | ISkuRegistry 接口实装（两资产合约）+ TradeLedger + GiftChannel + FixedPriceMarket + RentalChannel + admin 面板 | ✅ 已确认（2026-07-21）→ 开发中 |
| P2  | AuctionHouse（个人/系统拍卖）                                                                             | 待确认                    |
| P3  | TimedExchange / MiningClaim                                                                       | 待确认                    |
| P4  | FractionalVault（拆份永续，独立立项+审计）                                                                     | 暂缓                     |

- **部署顺序**：TradeLedger → 渠道合约 → 资产合约 setChannel 授权 → admin 导入。
- **硬性守则**：渠道合约不接任何奖励钩子；渠道停用只禁新单、存量可撤/可结算；每份渠道合约文档交付 = 完整 ABI + 参数说明 + SH 部署脚本 + 完整部署参数（沿用五份标准）。

<aside>  
✅

**2026-07-21 15:06 确认**：① P1 开始输出开发 TODOLIST + 合约代码；② FractionalVault 暂缓（P4，独立立项+审计）；③ RentalChannel 提前至 P1。

</aside>
