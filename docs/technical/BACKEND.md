# 后端技术设计

日期：2026-10-21 · 版本：v0.1 · 状态：房间基础能力已实现；计分业务仍为设计

## 1. 需求功能拆分

| 功能域 | 二级功能 | 后端职责 | 排除项 | 映射 |
| --- | --- | --- | --- | --- |
| B01 身份 | 可信微信身份映射、资料、最近访问 | openid→userId，资料最小化输出 | 手机号登录、前端传入身份 | R02、P08 |
| B02 房间 | 带玩法创建、预览、加入、成员、分享码 | 唯一码、成员唯一性、入房访问范围 | 加入前读取完整成绩/手牌 | H01—H06、R01—R06 |
| B03 活动 | 准备、名单、底分、规则版本、玩法切换 | 配置冻结、人数校验、并发切换 | 静默重算历史或补全未定规则 | R04—R05、P01—P04 |
| B04 九球 | 本人快捷正负分、流水、差额 | 可信本人记分，持续保存 | 杆次、上下家、自动关联扣分 | N01—N05 |
| B05 杀球 | 发牌、进球、撤销、转入、结果 | 随机一次、归属唯一、数量准确、完整入账 | 自动判罚、未确认的转归回退 | K01—K16、P09—P10 |
| B06 打分 | 公共牌领取/修正、预览、完整结果 | 同牌竞争、首次/最近操作者、完整性、唯一入账 | 未完成入累计、posted后直接改牌 | S01—S05 |
| B07 打大A | 系数乘底分、五人结果 | 精确计算和原子保存 | 自动主A、名次、明A判断 | A01—A04 |
| B08 打对家 | 两名赢家、倍数、四人结果 | 每人按1或2倍计算 | 固定线上搭档、出牌判定 | D01—D03 |
| B09 查询 | 房间快照、历史分页、详情、累计 | 成员授权、历史快照、投影读取 | 仅加载部分历史后求总分 | R06—R07 |
| B10 基础能力 | schema、授权、事务、收据、通知、日志 | 统一封装可复用Module | 通用公开CRUD、Express服务 | PRD 3.2 |

## 2. 设计基线及文档差异

业务以[当前PRD](../PRD.md)为准，[V4交付说明](../design/v4-handoff/HANDOFF.md)约束交互数据需求；[原数据模型](../DATA-MODEL.md)作为基础，下述增量覆盖过时部分：

- 创建房间必须接收mode，房间创建时可以还没有活动，不能让activeMode=null抹掉已选模式。
- 杀球已要求初始牌、进球状态、撤销和惩罚转归，必须记录，不再适用“杀球不建模归属”。
- 杀球一次发牌对应一个activity；保存结果后posted并保留牌，下一轮新activity，不在旧轮内覆盖牌。K04连续结果通过连续活动实现。
- 点球最终只入账一次；扑克一活动可以连续保存多笔结果，但需要独立结果槽位防跨用户重复保存。
- 原型不是权限规格，杀球他人牌可见范围保守处理为仅返回自己手牌和他人数量；P09后续放宽不影响核心模型。
- 底分精度、四人杀球少牌者等未定项配置化；字段齐备不等于默认开放全部策略。

## 3. 架构与职责分层

保留微信云开发云函数、文档数据库、实时监听。首版一个`api`业务云函数按action分发；`health`保持独立。内部函数不是HTTP路由，不使用Express/NestJS，不额外部署Web服务器。

```text
functions/api/index.ts
  → validation / trusted request context
  → ActionDispatcher（显式action表，不动态执行任意方法）
  → services/identity、room、activity、nine、kill、point、poker、query
  → repositories/事务内的定向数据操作
  → infrastructure/cloud、logging、notification

packages/shared/contracts  # DTO、Zod schema、错误码
packages/shared/scoring    # 无副作用计分函数
```

一旦业务部署需求实际分化再拆函数，不预先为每个字段创建单独云函数。所有端用户写入经过api，集合不开放客户端写权限。

### 3.1 Module与可复用Interface

| Module | 小Interface | Implementation负责的复杂性 | 复用范围 |
| --- | --- | --- | --- |
| Identity | resolveCaller(context) | appId/openid映射及唯一创建 | 所有动作 |
| AccessPolicy | requireMember / requireParticipant | 房间有效性、活动归属、本人写权限、能力配置 | 查询和写入 |
| CommandExecutor | execute(command, businessOperation) | canonical hash、成功收据、事务重试、同请求去重 | 所有写动作 |
| ScoreLedger | post(tx, event, postings) | 事件、活动累计、房间累计、单位校验、重复事件 | 九球与四类结果 |
| CardMutation | 模式内的明确命令 | 归属/进球revision、人数摘要、审计 | 杀球及打分共享内部工具，各自保留规则 |
| ReadModel | getSnapshot / listEvents / getEvent / getTotals | 按身份投影、分页、历史快照隔离 | 页面与重连 |
| Notifications | record(tx, changedScope) / deliver(job) | 事务outbox、成员信号、失败恢复 | 所有共享变更 |
| Scoring | calculate(input, config) | 精确单位、符号、完整名单、公式 | 预览与最终入账 |

repositories不对外开放任意collection/filter/update CRUD。事务句柄由业务事务传入，不能在Ledger或Repository内部偷偷另开事务。依赖从组合入口传入，使数据库Adapter与受控测试Adapter通过同一Interface验证；不引入仅有一份实现且无测试价值的多层工厂。

## 4. 接口契约

### 4.1 统一封装

```ts
type CommandEnvelope<A, P> = {
  action: A
  requestId: string
  payload: P
}
type CommandReceipt = {
  requestId: string
  entityId: string
  eventId?: string
  roomRevision?: number
  activityId?: string
  activityRevision?: number
}
```

查询不带requestId；业务写入必须带。action对应Zod判别联合schema，未知字段拒绝。userId仅在明确需要选择参与者或赢家时可传，actor永远来自可信上下文，不接受客户端openid或最终postings。

响应沿用`ApiResult<T>`；业务错误增补`ALREADY_POSTED / STALE_CONTEXT / RULE_NOT_CONFIGURED / IDEMPOTENCY_MISMATCH / RATE_LIMITED`，服务端生成traceId用于排障。实际网络超时不表示事务回滚，前端保留同requestId恢复。

### 4.2 查询动作

| action | 输入 | 输出与访问条件 |
| --- | --- | --- |
| identity.getMe | 无 | userId、显示资料；不公开openid |
| room.preview | joinCode | 最小房间信息/玩法/人数，不返回牌、历史或分数；限流 |
| room.listRecent | cursor, limit | 本人有效成员关系、房间摘要 |
| room.getSnapshot | roomId | 可信成员的模式/活动/参与者/分数/能力配置、本人signalId |
| room.listMembers | roomId, cursor | 成员展示信息，不暴露微信标识 |
| kill.getTransferCandidates | activityId | 1—15号、可选性、各牌revision；不返回其他人的owner/potted |
| result.getContext | activityId | 服务端底分、名单、configRevision、当前resultToken与状态 |
| history.list | roomId, mode, cursor, limit | 已授权且按隐私投影的事件摘要，稳定游标 |
| history.get | roomId, eventId | 单条授权详情；杀球过程详情不得泄露他人完整手牌 |
| totals.get | roomId, mode | 当前房间该玩法累计，不混单位 |

`room.getSnapshot`使用判别联合：九球含shortcuts/net；杀球含dealStatus、myCards和各人remainingCount；打分含15张公共牌/earnedPoints；扑克含底分/当前结果槽信息。DTO不得直接复用数据库文档类型。

### 4.3 写入动作及前置条件

公共roomId/activityId省略重复列示；所有活动写入校验房间、名单、活动配置状态。处于其他活动或旧配置的请求返回STALE_CONTEXT，不挪到新活动执行。

| action | 业务参数 | 主要约束 |
| --- | --- | --- |
| identity.updateProfile | displayName, avatarFileId? | 只改本人；不回写历史快照 |
| room.create | mode | mode必填，创建房间/成员/码一体成功 |
| room.join | joinCode | 校验码、房间状态；重复加入不增人数 |
| activity.prepare | roomId, expectedRoomRevision, participantIds, configInput | 启用所选mode；冻结名单/底分，校验人数；不能覆盖进行中牌局 |
| room.selectMode | roomId, mode, expectedRoomRevision | 只改变共享所选模式；存在未完成活动需明确处理策略，否则拒绝 |
| nine.addDelta | shortcutKey, direction | 目标隐含本人，金额从配置读取 |
| kill.deal | expectedActivityRevision | 只在undealt，人数及发牌策略明确后执行 |
| kill.setPotted | number, potted, expectedCardRevision | 只改当前属于本人的牌，显式目标状态，不用toggle |
| kill.transferIn | number, expectedCardRevision | 从别人转给调用者、恢复未进；不支持任意转给第三人 |
| kill.saveResult | winnerUserId, remainingBalls[], expectedActivityRevision | 允许人工核对，完整名单，按输入计算一次，posted后锁牌 |
| point.claim | number, expectedCardRevision | 只能null→本人 |
| point.changeOwner | number, targetUserId或null, expectedCardRevision | 当前参与者可修正，保存操作者 |
| point.saveResult | expectedActivityRevision | 必须15张齐且尚未入账 |
| daA.saveResult | resultToken, coefficients[], expectedConfigRevision | 五人完整、乘活动底分，不二次明A翻倍 |
| duiJia.saveResult | resultToken, winnerUserIds[2], multiplier, expectedConfigRevision | 四人，两赢家，multiplier为1或2 |
| result.startNext | activityId, previousResultToken | 仅扑克上一槽已保存后显式开下一次计算，幂等返回新槽 |

`activity.prepare`从当前选定mode读取规则，不允许客户端伪造rulesVersion/shortcuts；底分等用户可配置输入需要schema及策略校验。创建房间mode、选模式和实际开始活动分开，等待朋友时不生成错误人数的活动。

同一房间多个成员针对同一个shared resultToken同时保存，最多一个成功。独立线下结果不能靠参数相同自动去重；未经过startNext而拿旧token重复保存则返回已有结果。

### 4.4 版本检查规则

- 加法记分不要求前端带score revision，否则两人各自正常记分会被无意义拒绝；交易内读写activity状态确保不能写已切走的活动。
- 牌操作必须带cardRevision；修正/转入发生过任何变动后，旧revision一律CONFLICT，不能“同为未进”就覆盖。
- 完整牌结果用activityRevision校验，保证输入核对期间其他人改牌会触发重新核对。
- 房间切换使用roomRevision，独立于活动记分revision；历史配置不可原地变更。

## 5. 数据模型增量

### 5.1 rooms / activities

| 位置 | 增量 | 用途 |
| --- | --- | --- |
| rooms | selectedMode必填；activeActivityId可null | 创建已选mode、尚未开始活动；原activeMode可作兼容别名，不能维护两个相互独立的mode |
| activities | configRevision | 冻结底分/规则配置引用；不得与牌revision混用 |
| activities | capabilitiesSnapshot | 启用人数、快捷分值、策略版本；不保存UI样式 |
| activities（杀球） | dealStatus:undealt/dealt；dealId；dealPolicy；dealtAt；dealtBy | 防重复随机、恢复原分配 |
| activities（杀球） | completedResultEventId | 同一轮只入账一次，保存后status=posted |
| activities（扑克） | currentResultToken | 共享当前一笔结果，避免不同用户重复存同一笔 |

活动中的dealPolicy保留`participantOrder, distribution, shortHandUserId?, policyVersion`；三人为5/5/5，四人为4/4/4/3，少牌者策略不明时返回RULE_NOT_CONFIGURED，不暗中默认随机或房主少牌。

### 5.2 activity_cards扩展为判别联合

稳定主键为activityId+number，15张号码唯一。通用字段含mode、roomId、activityId、number、revision、updatedAt、updatedBy、schemaVersion。

| 模式 | 特有字段 | 不变量 |
| --- | --- | --- |
| kill_ball | initialOwnerUserId,currentOwnerUserId,potted,lastPottedBy?,lastPottedAt? | 发牌后始终恰有一名当前持有者；初始持有者不可覆盖；potted是当前归属下的状态 |
| point_ball | ownerUserId可null,firstClaimedBy?,firstClaimedAt?,lastModifiedBy? | 首次领取人保留，不随转归抹掉；当前归属仅能为活动参与者或null |

候选牌查询只提供revision等最小信息；原持有者和已进状态不默认返回。初始发牌结果完整保存在服务端，前端无权接收别人的手牌不妨碍服务端恢复。

### 5.3 activity_scores和score_events

- activity_scores为杀球增加`ownedCardCount / remainingCount`：后者等于当前owner下potted=false的数量。它不是净输赢netUnits。
- 新事件kind：`kill_dealt / kill_potted_changed / kill_transferred`，postings为空；payload记录牌号、初始/原/新owner、状态前后值、版本、操作者。读取时按权限过滤，不直接整条返回。
- kill_result存输入剩余数与牌面推导剩余数、`inputSource: manualConfirmed`及winner，便于解释人工核对，不静默用推导值替换人工输入。
- 预览不能改变netUnits；只有nine_delta和完整结果/未来冲正写postings。
- 原数据模型以不可变事件为计分依据的原则不变；杀球过程事件不计成绩，但为归属状态提供审计证据。

### 5.4 result_slots：扑克完整结果去重

| 字段 | 说明 |
| --- | --- |
| _id/resultToken | 不透明ID，活动内一笔结果标识 |
| roomId/activityId/mode | 归属 |
| configRevision/participantsSnapshot | 对应配置与名单 |
| status:open/posted | 当前结果是否已保存 |
| postedEventId / postedBy / postedAt | 唯一结果关联 |
| previousResultToken | 上一个结果槽；用于startNext业务唯一性 |
| createdAt / schemaVersion | 元数据 |

初次活动准备创建一个open槽；本地未保存系数不写槽。保存读取同一个槽并原子标posted。startNext通过`activityId + previousResultToken`确定性派生新槽，两个成员同时点再算一次只产生同一个新槽；槽内填写仍是各自本地输入，不增加多人共编草稿功能。

### 5.5 notification_outbox / user_room_signals

| 集合 | 主要字段 | 说明 |
| --- | --- | --- |
| notification_outbox | _id,roomId,activityId?,changeId,status,paginationCursor,leaseOwner,leaseUntil,attempts,nextAttemptAt,createdAt,deliveredAt? | 与业务写同事务，待投递任务可恢复 |
| user_room_signals | _id,_openid,roomId,signalVersion,updatedAt | 每用户每房间一条；仅刷新提示，不含分数、牌或身份资料 |

`_openid`由服务端可信映射写入，客户端不能写。信号文档ID由入房/快照接口返回给本人；使用平台“仅本人可读、客户端不可写”的安全规则。上线前在微信环境实际验证规则与watch行为，不能把伪规则表达式当部署完成。

### 5.6 索引增量

- result_slots：activityId+createdAt；业务唯一用确定性_id而非查后建。
- notification_outbox：status+nextAttemptAt、roomId+createdAt；lease过期可重领。
- user_room_signals：_openid+roomId；仅本人监听指定文档，不全表扫描。
- activity_cards继续activityId+number；杀球也按activityId+currentOwnerUserId支持读取本人牌。
- score_events继续roomId+mode+createdAt+_id分页，过滤过程/最终类型需要匹配索引。

## 6. 单功能事务设计

### 6.1 B01/B02 创建与加入

Identity.resolveCaller以appId+openid的服务端摘要得到稳定用户ID，事务插入用户占位防并发创建两个身份。显示资料不足不读取未经授权的微信资料。

room.create事务写：room(selectedMode)、唯一room_code、创建者member、signal占位、commands收据。没有mode拒绝，不提前创建空房间。码碰撞时在受限次数内换码重试，requestId不变；随机候选在一次事务重试内保持固定，不能在每次回调中任意重算。

room.join事务读码/room状态，幂等创建成员及本人signal，不重复增memberCount；不插入当前活动名单。预览和加入分别鉴权与限流，不能把“预览成功”作为长期入房授权。

### 6.2 B03 活动准备与选择模式

校验所有参与者为active成员、人数符合策略、配置可表达、当前活动处理策略允许→冻结名单和配置→创建activity/个人投影；打分创建15张空公共牌，扑克创建open结果槽→更新room当前活动引用与revision→outbox+收据。

如果旧活动仍未完成且切换/恢复策略未确定，返回明确活动未完成冲突；不能通过技术设计偷偷将旧活动归档或清牌。九球新增成员通过新活动名单保留旧账，但入口是否启用遵循P02。

### 6.3 B04 九球

从配置读取shortcutKey及方向对应delta，actor即目标。一次事务校验room当前活动、status=open、调用者在名单→写nine_delta→更新本人activity_scores、room_scores→活动revision递增→outbox+收据。

不更新他人或roomRevision；活动revision使九球快照可判断前后，并与切换/归档形成冲突保护。人数仅2/3；两人配置缺失时不猜大金+20。不要求事件零和，差额是查询计算结果。

### 6.4 B05.1 杀球发牌

通过注入的RandomSource进行Fisher–Yates洗牌；生产Adapter使用Node安全随机整数，测试Adapter可固定序列，不在页面Math.random发牌。

事务前生成本请求候选分配，事务中读活动undealt且已有固定参与者、合法distribution，写15牌与initialOwner/currentOwner、全部剩余数量、kill_dealt、dealt状态→outbox+收据。事务因冲突重试时沿用本请求候选。

另一用户不同requestId同时发牌：若已有dealId，返回已有分配的授权视图/标识，不覆盖。成功读回快照时只显示本人牌。

### 6.5 B05.2 进球与撤销

`setPotted`显式true/false：读活动dealt/open、牌当前owner=actor、cardRevision匹配；以目标状态计算remainingCount变化并写审计事件。相同请求先查收据返回，不能把toggle再执行一次。

新请求但目标状态已经满足且版本仍匹配可返回无变化成功；旧版本返回CONFLICT。转归已改变owner后，原owner再点撤销必须拒绝，不允许凭initialOwner修改。

### 6.6 B05.3 惩罚转入

事务内读牌与expectedRevision，确认原owner不是actor且在本活动→保存原owner与potted用于审计→currentOwner=actor,potted=false，initialOwner不变。

数量变化：新owner remaining+1、owned+1；旧owner owned−1，其remaining仅在原potted=false时−1。所有修改及事件同事务，不让“移出”和“移入”分别成功。同一个球不同人同时转入，只有一个版本成功。

此命令不需要原owner在线审批，不是程序判罚。误转归回退P09未开放；进球撤销只改potted，不恢复旧owner。

### 6.7 B05.4 杀球最终结果

读取activityRevision及赢家、完整输家剩余输入，输入为非负整数且安全范围内；不按个人初始5/4/3限制。赢家所得=sum(输家剩余)，各输家负数；牌面推导值仅保存为参考快照，不强制覆盖人工核对。

事务原子写kill_result及Ledger全部投影、活动posted/completedResultEventId、outbox、收据。同activity任何再次保存都返回已有结果，即使requestId不同。保存和进球/转归共享活动revision锁，不能产生结果与随后同轮牌面变化不一致。

posted后保留牌面、禁止过程修改；下一轮新activity。发牌权限、四人少牌策略、下一轮入口分别由P10配置，三人进球/转归的确定逻辑可先实现。

### 6.8 B06 打分公共牌和完整结算

领取：null→actor；修改：当前owner→指定参与者或null。校验cardRevision和activity=open，更新原/新earnedPoints、ownedCardCount、card归属及操作者、活动revision，写过程事件和outbox，不产生postings。

首次领取时设置firstClaimedBy/At，后续转归和退回保留此审计字段；lastModifiedBy反映最新操作者。

保存：同事务读活动和15张牌，确认均归名单成员、总分120，计算baseline=120/N，以统一scale精确表达后算net。写唯一point_result、累计、posted标志、outbox、收据。首次读取活动doc与最终写活动doc形成并发保护，改牌事务也必须写同一doc。

三人界面基准40，四人公式虽可计算，不因此直接开放未确认的四人界面。posted后更正未明确前拒绝直接改牌。

### 6.9 B07/B08 扑克结果

result槽及活动配置均在事务中读取。大A五人系数必须完整且不重复，精度与coefficientScale匹配；服务端只乘baseStake，不根据牌规则翻倍。非零和由明确策略决定，未配置不给前端猜测保存。

对家赢家恰好2人且均在四人名单，multiplier=1/2，生成每人±baseStake×multiplier。

Ledger.post + slot标posted + outbox + receipt同事务。两个用户保存同slot：只有一个成功，另一人返回ALREADY_POSTED及已有事件标识，不把两份不同输入叠加。不同resultToken代表不同线下结果，不能因数值一样去重。

### 6.10 B09 查询和历史一致性

房间快照以事务读取room和当前activity、最多15张牌及至多5位活动成绩，得到一致版本；房间成员列表单独分页，不把无限成员列表放进快照。根据actor输出本人牌与公开数量。

历史按不可变事件的时间+ID游标分页，事件内容被授权ReadModel投影。累计读取room_scores，不用分页历史求和。投影修复工具按有效postings重建；真实更正采用冲正事件，不删除旧事件，不在本次开放用户冲正入口。

## 7. 幂等、同步与授权的复用设计

### 7.1 两种去重各自解决问题

1. **命令去重**：`actorUserId + requestId`确定commands ID，canonical payload hash包含action和全部规范化参数。同ID不同参数返回IDEMPOTENCY_MISMATCH。
2. **业务唯一**：打分/杀球活动只允许一个completedResultEventId，扑克resultToken只允许一笔事件。不同成员不同requestId也不能重复保存同一个结果。

先验证可信身份、当前访问资格，再在事务中判断是否已有收据，已有则返回最小原收据，不返回未经当前授权的旧敏感快照。事件与收据在同一事务，不建长期pending命令文档。超时查询可直接以同action/requestId/payload重试，不能根据“未收到响应”假设失败。

### 7.2 Ledger与精确单位

Ledger接收已按玩法计算的postings，校验参与者集合/scale/安全整数；按eventId确定唯一事件。涉及所有人的活动及房间累计必须在一个事务中成功或回滚。

shared/scoring建议Interface：

```text
calculateKillResult(winnerId, remainingByUser) → Delta[]
calculatePointResult(owners, participants, scale) → Delta[]
calculateDaAResult(coefficients, stakeUnits, coefficientScale) → Delta[]
calculateDuiJiaResult(winners, participants, multiplier, stakeUnits) → Delta[]
resolveNineDelta(shortcutKey, direction, rules) → Delta
```

不在纯函数内写数据库、读身份或随机发牌。前端预览和后端存账调用同一公式；后端重新校验参与者及配置，不能信任前端已调用过公式。

### 7.3 实时监听的明确落点

不要求客户端直接监听包含全部私人牌的业务集合，也不以“where roomId”充当权限。

采用**本人可读信号 + 鉴权快照查询**：

1. 每笔影响共享视图的事务写notification_outbox，不直接在未提交前发通知。
2. 提交后尝试投递：枚举当前有效房间成员，为各自user_room_signals递增signalVersion。活动人数与房间成员数分开，投递按分页处理，不能假定房间永远只有5个成员。
3. 前端watch本人当前房间signal；收到变化刷新room.getSnapshot。
4. outbox投递失败保留任务，由定时内部worker领取lease重试；投递可至少一次，重复信号只导致重复刷新，不导致记分。
5. 投递期间新增成员通过加入时完整快照得到当前状态；以后变更正常投递。已离开成员可能收到残留信号，但信号不含成绩或牌，实际查询仍重新校验资格。
6. 前台恢复必拉快照，可见状态下低频鉴权查询用于通知延迟兜底；不承诺离线写入或普通云函数WebSocket长连接。

signal是刷新提示，不是数据真相；事件处理晚到不得把旧成绩复制进signal。outbox按变更ID和分页进度恢复，重复递增允许，只有所有目标投递完成才标delivered。worker定时调用入口必须依赖云平台受控调用权限，不能仅检查event里一个`internal:true`字段。

这种方案增加两个轻量集合，但避免为每个业务集合编写复杂跨集合客户端读权限，并支持杀球本人牌投影。无需消息队列、Redis或额外Web服务。安全规则、定时触发及watch可用性需要真环境集成验证。

## 8. 权限和业务边界矩阵

| 能力 | 未入房微信用户 | 房间成员但非当前参与者 | 当前参与者 |
| --- | --- | --- | --- |
| 有效码预览/加入 | 限流允许 | 已加入直接恢复 | 已加入直接恢复 |
| 房间元数据/累计/历史结果 | 禁止 | 允许成员可见结果 | 允许 |
| 杀球具体手牌 | 禁止 | 不返回手牌 | 仅本人 |
| 九球加减 | 禁止 | 禁止 | 仅本人 |
| 杀球进球/撤销 | 禁止 | 禁止 | 仅当前owner |
| 杀球惩罚转入 | 禁止 | 禁止 | 目标只能本人 |
| 打分领取/更正 | 禁止 | 禁止 | 可领取本人、修正给本场成员 |
| 完整结果保存 | 禁止 | 禁止 | 允许，受唯一性和配置约束 |
| 访问openid/其他人收据 | 禁止 | 禁止 | 禁止 |

“所有成员都能记分”表示没有房主专属记分员，不表示新入房者可以改未参加的当前活动。发牌权限、重发、历史冲正尚未定义，不依据createdBy偷偷开放；配置缺失明确拒绝。

所有业务集合默认客户端拒绝读写；只有本人signal集合开放受约束读取和监听，写入仍拒绝。后端SDK绕过客户端安全规则，所以每个查询/写入也必须执行业务授权，不能只配置数据库权限。

## 9. 可复用与不应统一的功能

可共享：命令执行、错误码、schema、积分单位、Ledger、事务Repository、快照授权、通知投递、版本检查工具。

不能强行统一：

- 杀球的potted与打分的owner=null并非同一状态。用判别联合共享存储通用字段，各自独立行为，不建立万能“改牌字段”客户端命令。
- 九球单人非零和增量与完整零和结果不能都强制同一结果校验器。
- 杀球进球撤销是过程状态恢复，不是Ledger冲正，也不是归属转移撤销。
- 结果入账与活动结束不绑定：九球持续；扑克每笔槽posted但activity继续；杀球/打分一轮posted后锁牌。
- rooms与activities的revision职责不同，不把所有写入都更新room造成全房间热点；单活动revision用于一致快照和完成锁，规模为朋友间低频操作，冲突需有受限重试。

## 10. 运维、错误和验证

### 10.1 运维约束

开发和生产分开云环境，环境ID是配置，服务端凭据不入库。使用当前工程esbuild独立函数部署，shared/schema一起打包，wx-server-sdk由部署依赖安装。health只证明入口可运行，不证明数据库权限或事务正常。

结构化日志包含traceId/action/requestId/实体ID/耗时/业务错误码；不记录openid、完整牌组和原始请求。保留基础失败、冲突、重试次数与outbox积压观测，不增加用户后台或复杂监控平台。

代码的参数size、分页limit、码查询限流、事务最大重试次数需有部署配置；具体数值实施时测量确定，不能无限重试。事务能力和单次写入数量需在真实SDK核验：本设计常规最多15牌+5分数规模，outbox投递不放进无限成员大事务。

### 10.2 功能验收与测试拆分

| 阶段 | 内容 | 必须验证 |
| --- | --- | --- |
| BE-1 | 契约/schema、身份、CommandExecutor、Ledger、精确公式 | 同请求同参数一次；不同参数拒绝；0分平局可保存；单位溢出拒绝 |
| BE-2 | 带mode创建/入房/准备、权限、快照、信号/outbox | H01—H06、成员重复加入、无资格读写被拒绝、信号不泄露手牌 |
| BE-3 | 杀球15牌及全部过程 | K05—K16；5/5/5与配置后4/4/4/3、重复发牌、进球撤销、已进/未进转归计数 |
| BE-4 | 打分及两种完整结果 | S/A/D用例、多人抢同牌、跨用户同resultToken最多一次 |
| BE-5 | 九球持续记账、历史累计、故障恢复 | N01—N05、切换冲突、丢响应后重试、outbox失败恢复、重建累计一致 |

测试优先跨Module Interface验证行为。共享公式使用已确认示例；事务测试在真实测试环境执行并发，而不只用内存Adapter假设数据库会锁住；随机发牌测牌号集合、互不重复及数量，不依赖一次随机输出。

关键竞争：标进/转归、撤销/转归、改牌/最终保存、两人发牌、两个用户保存同结果、切换活动/旧页写入、写成功响应丢失。每种验证“唯一结果、投影正确、审计存在”，不是仅检查返回码。

## 11. 实施前提和交付状态

已实现identity.getMe/updateProfile、room.create/preview/join/listRecent/listMembers/getSnapshot/selectMode、activity.prepare及对应共享schema、幂等事务、SDK Adapter和19项本地测试。操作细节和工程默认策略见[基础接口联调说明](../../apps/cloud/FOUNDATION.md)。Ledger、实际发牌/计分、通知worker及客户端signal安全规则尚未实现；真实云环境尚未部署。

P01—P10仍影响策略配置，不影响字段与Module准备：可以先完成三人杀球和三人打分、本人九球基本项与房间基础能力；未定操作返回RULE_NOT_CONFIGURED，不能静默猜规则。后续应将本节增量同步至DATA-MODEL后再创建集合，防止按旧杀球模型实现。
