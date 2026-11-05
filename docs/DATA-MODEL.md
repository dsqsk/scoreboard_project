# 数据模型设计

日期：2026-10-20  
状态：基于PRD的实施设计，未创建数据库。  
依据：[PRD](./PRD.md)、[技术选型](./TECH-STACK.md)。本文补齐工程字段，不新增玩法自动判定能力。

## 1. 核心关系与建模原则

```text
users ── room_members ── rooms
                          │
                          ├─ activities ── activity_cards
                          │       │
                          │       ├─ activity_scores
                          │       └─ score_events
                          └─ room_scores

room_codes → rooms
commands → 对应业务结果
```

- 房间是共同记分空间；activity是一次采用固定参与名单与规则配置的记分活动，不强制等同一局。
- 九球activity可以长时间持续，逐次加减产生流水，不要求结束。杀球、扑克activity可以连续保存多笔结果。打分activity承载一套1—15号牌。
- 五种玩法分别累计，积分始终属于用户ID，姓名仅为展示信息。
- 不可变计分事件为成绩依据；activity_scores、room_scores为可重建的汇总。
- 每套完整结果是一条事件，其中包含全部参与者变动。公共牌分配不是最终成绩事件，不能直接累计到房间成绩。
- 核心业务集合仅服务端写入。客户端读取与监听通过成员权限控制的专用读接口实现；不能用客户端查询条件代替授权。

## 2. 通用类型与约定

| 类型 | 定义 |
| --- | --- |
| ID | 服务端生成的不透明字符串；不使用姓名或房间码作为用户/房间主键 |
| Mode | `nine_ball / kill_ball / point_ball / da_a / dui_jia` |
| Timestamp | 服务端生成的数据库时间戳；客户端时间不决定顺序 |
| Units | 安全整数表示的最小记分单位，禁止用浮点数直接累加 |
| Revision | 非负整数，服务端提交成功后递增，用于并发检测 |

活动包含`scoreScale`：展示分数=Units÷scoreScale。杀球固定1，九球默认1；扑克和打分可按确定的小数精度配置为10的整数次幂。规则系数另用`coefficientScale`表示。所有乘除必须校验整除和安全整数范围，不能静默舍入。

例如底分0.5、scoreScale=100，则底分存50；基础分6存6、coefficientScale=1；最终存300，展示+3分。打分最终公式为`earnedPoints×scoreScale − 120×scoreScale÷N`；配置时必须确保基准可精确表达，否则不启用该人数配置。支持哪些人数和小数仍遵循PRD待定范围。

所有持久化文档含`_id`、`schemaVersion`；可变文档含`createdAt / updatedAt / revision`。示例中的`createdBy`均由云函数可信身份生成，不接受客户端冒充。

## 3. 集合设计

### 3.1 users：用户身份

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | ID | 内部用户ID |
| wechatAppId | string | 身份所属小程序 |
| wechatOpenId | string | 云函数可信上下文取得，禁止向其他成员返回 |
| displayName | string | 用户显示名，不要求自动读取微信昵称 |
| avatarFileId | string或null | 可选头像资源 |
| status | active / disabled | 用户状态 |
| lastSeenAt | Timestamp | 最近访问时间，不作为严格在线判断 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 元数据 |

身份映射保证`wechatAppId + wechatOpenId`唯一，可用服务端摘要构造确定性ID，不能仅先查后建。无需手机号、微信联系人、密码或支付身份。

### 3.2 rooms：房间

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | ID | 永久房间标识 |
| displayName | string | 默认或自定义展示名，字段不代表必须交付编辑入口 |
| createdBy | userId | 创建者，非唯一记分员 |
| status | active / closed | 逻辑状态；关闭入口尚未确定 |
| activeActivityId | ID或null | 当前房间正在使用的活动 |
| activeMode | Mode或null | 当前玩法读优化字段，与活动保持一致 |
| activeCodeId | string | 当前可加入的房间码 |
| memberCount | integer | 有效房间成员数，不等于当前活动人数 |
| expiresAt / closedAt | Timestamp或null | null表示未设置期限；不预设自动过期 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 元数据 |

不在房间文档存无限增长的历史或全部活动累计。房间revision只处理房间配置变化，不因每次加分写同一房间文档。

### 3.3 room_codes：可分享加入码

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | string | 规范化房间码，具体长度/字符集由入口设计确定 |
| roomId | ID | 对应房间 |
| status | active / revoked | 可用性 |
| expiresAt | Timestamp或null | 码的有效期 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 元数据 |

房间码通过确定性文档ID占位保证唯一；创建碰撞时重试。微信分享携带此码或专用服务端签发令牌，不把数据库文档ID当作访问权限。查询码仅返回加入确认需要的信息，加入后才能读成绩。加入码查询需限制频率，防止遍历。

### 3.4 room_members：成员关系

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | roomId与userId的稳定组合 | 每人每房间仅一条关系 |
| roomId / userId | ID | 归属 |
| displayName / avatarFileId | string / nullable | 房间成员展示资料，更新不重写历史快照 |
| status | active / left | 当前成员关系，退出入口待定义 |
| joinedAt / leftAt | Timestamp / nullable | 加入与离开时间 |
| joinSource | create / code / share | 加入来源 |
| lastVisitedAt | Timestamp | 最近进入，支持最近房间 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 元数据 |

不设旁观者角色。是否参加当前活动由activity的固定参与名单判断；新加入房间不自动插入已开始活动。

### 3.5 activities：记分活动及不可变配置

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id / roomId | ID | 活动与房间 |
| mode | Mode | 玩法 |
| status | open / posted / archived | 可记分、打分完整结果已入账、活动已归档；九球不要求归档 |
| createdBy | userId | 创建活动者 |
| participantIds | userId[] | 固定名单；包含成员和人数校验 |
| participants | object[] | `{userId, displayName, avatarFileId, position}`历史展示快照；position仅用于展示，不是击球顺序 |
| rulesVersion | string | 本活动计算规则版本 |
| scoreScale | integer | 本活动分数单位倍率 |
| config | 按玩法区分的object | 下面列明的规则/底分快照 |
| completedResultEventId | ID或null | 打分完成事件，确保一套牌只入账一次 |
| startedAt / archivedAt | Timestamp / nullable | 生命周期元数据，无逐局计时用途 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 活动与卡牌并发版本 |

config结构：

| 玩法 | 字段 |
| --- | --- |
| nine_ball | `shortcuts[]: {key,label,positiveUnits,negativeUnits}`；三人大金明确+20/−10；无上下家和当前杆状态 |
| kill_ball | `unit: "ball"`，赢家按输家剩余数求和 |
| point_ball | `cardNumbers: [1..15]`、`totalPoints:120`、`baselineUnits` |
| da_a | `baseStakeUnits`、`coefficientScale`；基础分由人输入，不存自动判身份规则 |
| dui_jia | `baseStakeUnits`、`allowedMultipliers:[1,2]` |

活动开始后名单、规则版本、倍率与底分快照不可原地修改。若未来允许中途改底分或人数，通过新activity保存新配置，旧流水不重算；是否提供此入口不由数据模型决定。打对家不要求预设固定搭档，每次结果指定两名赢家。

### 3.6 activity_cards：打分公共牌

每个point_ball活动创建15条，`_id`由activityId+球号确定，集合之外的玩法不创建。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| roomId / activityId | ID | 归属 |
| number / points | integer | 1—15，points=number，创建后不可变 |
| ownerUserId | userId或null | 当前归属 |
| updatedBy | userId或null | 最近选牌/修改人 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 版本用于防止覆盖新归属 |

牌的首次领取仅接受owner=null；修正需要提交所见revision，旧版本请求冲突后刷新，不静默覆盖。退回即owner=null。变更事务同时更新活动revision、牌归属和活动内进球分，最终保存事务检查同一活动revision，防止读到一半修正的状态。

### 3.7 score_events：不可变业务与计分流水

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | ID | 唯一事件ID，可由command稳定派生 |
| roomId / activityId / mode | ID / Mode | 查询与归属 |
| kind | 枚举 | nine_delta / kill_result / point_card_change / point_result / da_a_result / dui_jia_result / reversal |
| actorUserId | userId | 真实操作人 |
| commandId | ID | 幂等请求关联 |
| rulesVersion / scoreScale | string / integer | 计算解释快照 |
| participantsSnapshot | object[] | 结果涉及的人名/ID快照，不含openid |
| payload | 按kind的object | 见下表 |
| postings | object[] | `{userId, deltaUnits}`；仅最终记账结果影响累计 |
| reversalOfEventId | ID或null | 为未来冲正预留，不默认开放更正功能 |
| createdAt / schemaVersion | 通用 | 不提供原地updatedAt或修改计分结果 |

| kind | payload所需字段 | postings |
| --- | --- | --- |
| nine_delta | `userId, shortcutKey, direction, amountUnits` | 仅本人，允许非零和 |
| kill_result | `winnerUserId, remainingBalls:[{userId,count}]` | 全体参与者，合计0 |
| point_card_change | `number, fromUserId, toUserId, beforeRevision, afterRevision` | 空数组，不影响房间累计 |
| point_result | `cards:[{number,ownerUserId}], earnedPoints:[{userId,points}], baselineUnits` | 全体，完整分配后合计0 |
| da_a_result | `baseStakeUnits, coefficientScale, coefficients:[{userId,value}]` | 全体，服务端乘底分；非零和策略见PRD P07 |
| dui_jia_result | `baseStakeUnits, multiplier, winnerUserIds` | 全体，恰好2赢家，合计0 |
| reversal | `originalEventId, reason` | 原事件postings反向；权限及开放入口待P05 |

最终记录即使全员0分也可以保存，不因无累计变化丢掉有效平局。point_card_change历史可按kind筛选，不与完整结果混成重复入账。

### 3.8 activity_scores：活动内成绩投影

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | activityId与userId的稳定组合 | 一活动一人一条 |
| roomId / activityId / mode / userId | 归属 | 查询条件 |
| scoreScale | integer | 与活动一致 |
| netUnits | integer | 已入账成绩，九球用于持续记分 |
| earnedPoints | integer | 仅打分：进行中已领取号码之和，其余玩法为null |
| ownedCardCount | integer或null | 打分已领牌数量 |
| lastEventId / lastPostedAt | nullable | 最近有效记账事件 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 投影版本 |

打分未结算时netUnits为0，earnedPoints用于进球分展示；差额或最终输赢不混入进行中数据。九球差额为当前activity所有netUnits之和。其他玩法可展示该活动连续多笔结果累计。

### 3.9 room_scores：房间按玩法累计

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | roomId、mode、userId的稳定组合 | 每房间每玩法每人一条 |
| roomId / mode / userId | 归属 | 唯一统计维度 |
| unit | point / ball | 分或颗 |
| scoreScale | integer | 房间该玩法统一倍率，首笔前确定，此后不能混用 |
| netUnits | integer | 对应有效postings之和 |
| lastEventId / lastPostedAt | nullable | 近期信息 |
| createdAt / updatedAt / revision / schemaVersion | 通用 | 投影版本 |

不同活动进入同一room+mode时必须使用同一scoreScale。以后若升级精度，先做明确的数据迁移，不能直接把不同倍率数值相加。累计不存排名、金额、胜率或跨房间总分。

### 3.10 commands：幂等命令收据

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| _id | 可信userId与requestId的稳定组合 | requestId由客户端为一次主动操作生成，重试沿用 |
| actorUserId / roomId / activityId | ID | 身份与上下文 |
| action | string | join_room / create_activity / submit_score / claim_card等 |
| payloadHash | string | 同requestId但不同参数应拒绝，不能误返回旧成功 |
| result | object | 已成功操作返回的事件ID、活动ID或必要结果摘要 |
| createdAt / schemaVersion | 通用 | 成功收据，不存长期pending |

成功收据和业务结果在同一事务写入。校验失败直接返回错误，不留下半条成绩；网络结果未知时客户端用相同requestId重试。首版不自动清理收据，避免旧请求因收据过期再次记账。若未来需清理，必须同时设计永久业务去重依据。

## 4. 关键事务与约束

### 4.1 创建/加入房间

- 创建房间、分配唯一码、创建创建者room_member与命令收据在同一业务事务完成；重试返回同一房间。
- 加入校验码有效、房间有效；已存在有效成员直接返回，不重复增加memberCount。
- 加入仅建立房间关系，不修改当前活动participantIds。

### 4.2 九球记分

校验可信用户在participantIds中、目标userId等于本人、快捷项及正负分与活动配置一致→写事件→原子更新activity_scores与room_scores→写命令收据。

不要求postings合计0，不更新其他参赛者成绩，不保存上家/下家/当前杆字段。九球不需要写入或结束一个“局”对象。

### 4.3 杀球、打大A、打对家保存

验证固定参与名单完全匹配，服务端重新计算所有postings→同一事务写一条事件、全部个人投影及命令收据。底分从活动配置读取，不接受客户端自行替换。杀球剩余数为非负整数，打对家赢家必须是不同的两名参与者。

打大A的主方、名次、明A均不设业务字段。基础分包含线下已经确定的规则影响，不重复自动翻倍。非零和输入是否允许保存遵循P07，代码不能用不存在的规则擅自修正。

### 4.4 公共牌选择/更正

事务检查活动open、调用者属于当前参与者、牌revision匹配→更新归属→更新原/新用户earnedPoints与ownedCardCount→活动revision加1→写point_card_change与收据。首次领取只能归调用者，更正可选当前参与者或退回，符合PRD所有成员可修正约定。

每次变更都写活动revision，最终结算也写同一活动文档形成并发冲突检测，避免结算和改牌同时成功却基于不同快照。

### 4.5 打分完整入账

事务检查15牌均归本活动参与者、总分120、活动open且completedResultEventId为空→重新计算分数→写point_result及累计→设置活动posted和completedResultEventId→写收据。

该业务唯一约束独立于requestId：即使不同用户同时以不同请求保存，也只能有一次完整结果入账。posted后禁止直接改牌；更正必须采用未来明确的冲正流程。

### 4.6 投影校验与修复

房间累计应等于所有对应mode事件的postings之和，活动累计按activityId求和；牌的earnedPoints应等于当前归属牌号码之和。预留服务端重建工具能力，不增加用户后台页面。冲正以新事件相抵，不能删除旧流水或只改累计。

## 5. 读取、实时同步与隐私

- 服务端`getRoomSnapshot`返回公开成员展示、当前活动及分数，不返回其他人的openid或命令收据。
- `listEvents`按roomId、玩法、时间和ID分页，不一次加载全部历史。
- 实时同步沿用已确定的数据库监听方案。接口实现前验证微信云开发客户端watch的安全规则能否可靠校验room_members关系；能实现则直接监听成员可读的活动/分数/卡牌集合。不能实现时需要调整授权读模型，不能放宽为全员可读。鉴权云函数增量轮询仅作可用性降级方案，不将普通云函数假设为长连接订阅桥接，也不引入自建WebSocket。
- 监听只是刷新信号；恢复前台或重连后重新获取可信快照。基于revision拒绝旧快照覆盖新数据。
- 共享成员状态只含必要展示资料。禁止客户端批量读取users或commands集合。房间码加入前只能获得有限预览。

## 6. 索引与查询计划

确定性_id承担业务唯一性，不依赖“查询未找到再新增”。具体索引语法与可用能力在初始化时按选定SDK验证。

| 集合 | 索引字段（查询方向） | 用途 |
| --- | --- | --- |
| room_members | userId, status, lastVisitedAt降序 | 最近房间 |
| room_members | roomId, status, joinedAt | 房间成员 |
| activities | roomId, mode, createdAt降序, _id | 活动历史 |
| activity_cards | activityId, number | 一套公共牌 |
| activity_scores | activityId, userId | 当前活动成绩 |
| room_scores | roomId, mode, userId | 房间某玩法累计 |
| score_events | roomId, mode, createdAt降序, _id降序 | 玩法记录分页 |
| score_events | activityId, kind, createdAt降序, _id降序 | 活动/改牌历史 |
| score_events | reversalOfEventId | 未来防重复冲正；另用确定性收据保证唯一 |

时间相同使用_id作为稳定游标补充，不能只靠毫秒时间戳区分或去重。

## 7. 不建模的内容

- 九球杆次、击球顺序、逐局胜负、自由球、黄金九、黑金和让杆大金。
- 杀球初始分牌、号码归属、惩罚过程。
- 扑克108张牌、出牌记录、隐藏身份、牌型、名次自动判定。
- 支付账户、资金转账、提现、跨房间排行榜和旁观者角色。

PRD未确定的权限、生命周期与精度作为配置或未来流程保留，不为此阻塞字段设计，也不将预留字段等同已承诺功能。

## 8. 模型验收场景

| 场景 | 数据期望 |
| --- | --- |
| 九球A一次大金正分 | 一条nine_delta、仅A的两个分数投影各+20，其他人不变 |
| 相同请求重试 | 返回原结果，无新事件，无再次累计 |
| 两人同时领取6号 | 一次成功，一次冲突；只有一人earnedPoints增加6 |
| 改牌与完整结算并发 | 基于活动revision串行生效；不能产生归属与结算快照不一致 |
| 两人同时保存同套完整打分 | 只有一个point_result，累计只增加一次 |
| 三人杀球剩余2、3 | 一条结果含+5、−2、−3，所有投影同步更新 |
| 打大A底分5、基础6/3/−3/−3/−3 | 同一事件存底分快照，postings为+30/+15/−15/−15/−15对应的Units |
| 打对家底分10、抓两个 | 两名赢家各+20、其余各−20，单事务保存 |
| 保存过程中故障 | 事件、投影与命令收据全部成功或全部回滚 |
| 显示名或新活动底分改变 | 已有事件姓名和底分快照不变 |
| 新成员加入 | 新增room_member，不重算当前打分基准、不改历史名单 |
| 切换玩法 | 对应mode分别统计，不将分与颗混算 |

以上为设计验收要求，尚未执行数据库或并发测试。
