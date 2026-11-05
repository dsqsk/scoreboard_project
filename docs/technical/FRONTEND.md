# 前端技术设计

日期：2026-10-21 · 版本：v0.1 · 状态：实现设计，尚未实现业务代码

## 1. 功能拆分与交付依据

### 1.1 一级功能及子功能

| 功能域 | 二级功能 | 前端负责 | 不负责 | 需求映射 |
| --- | --- | --- | --- | --- |
| F01 身份与首页 | 身份恢复、创建模式选择、房间码查询、加入确认、最近房间 | 输入、导航、请求反馈、展示身份 | 生成可信身份、认定入房资格 | H01—H06、R01—R02 |
| F02 房间与活动 | 房间信息、分享、成员、固定参与名单、玩法切换、底分准备 | 展示服务端活动配置，维护未保存表单 | 修改历史配置、自动拉人进当前活动 | R03—R06、P02/P04 |
| F03 九球 | 本人成绩、快捷正负记分、差额、最近记录 | 一次点击提交本人操作，显示差额 | 上下家、杆次、自动扣他人分 | N01—N05 |
| F04 杀球 | 随机发牌、我的牌、他人剩余数、进球、撤销、惩罚转入、结果保存 | 按牌组织交互、局部pending、结果核对 | 随机分配算法、判罚、直接改他人手牌 | K01—K16 |
| F05 打分 | 三家进球分、公共牌、领取、归属修正、进度、完整结算 | 直接领取给本人，展示修改人及预览 | 判击球有效性、未完成计入累计 | S01—S05 |
| F06 打大A | 底分、五人基础分、预览、主动保存 | 输入系数，调用共享公式预览 | 判断主A、同伙、明暗A、名次 | A01—A04 |
| F07 打对家 | 底分、抓一/抓二、两名赢家、预览保存 | 选择与预览 | 出牌过程与自动判胜 | D01—D03 |
| F08 记录与累计 | 玩法过滤、分页、详情、单位、历史快照 | 独立展示不同玩法数据 | 跨房间总榜、未开放的改账 | R07、P05 |
| F09 共享交互能力 | 云调用、写入状态、幂等重试、监听、重连、安全区、弹层 | 封装通用Module，供功能复用 | 在UI中实现数据库事务 | PRD 3.2、交付说明同步约束 |

### 1.2 来源优先级与差异处理

1. [当前PRD](../PRD.md)决定业务；[V4交付说明](../design/v4-handoff/HANDOFF.md)、tokens和素材决定首页/杀球/打分的视觉实现。
2. [UI/UX文档](../UI-UX.md)补充五玩法流程，但其旧“先创建再选模式”被PRD H01—H06替代：必须先选模式再创建。
3. V4石墨绿背景、薄荷强调、米白牌替代UI/UX旧浅色建议；不使用V5，也不复制原型中的示例身份或假保存逻辑。
4. 当前PRD杀球已要求随机发牌及牌状态，旧[数据模型](../DATA-MODEL.md)中的杀球不记录归属条款不再有效，后端设计提供增量字段。
5. V4没有九球和扑克高保真稿；这三种页面沿用V4设计变量和UI/UX行为，不虚构已有视觉验收。

## 2. 工程结构与Module划分

沿用Taro + React + TypeScript + Vite和npm workspaces；全局状态使用Zustand，不新增Redux、跨端适配或网页路由框架。以下目录是规划，不表示已生成。

```text
apps/miniapp/src/
  app.tsx / app.config.ts
  pages/
    home/              # 首页与模式选择
    join/              # 分享/房间码的共同加入确认
    room/              # 房间记分、记录、累计的承载页
  features/
    identity/          # 身份恢复及显示资料
    room/              # 房间准备、成员和分享
    nine-ball/
    kill-ball/
    point-ball/
    da-a/
    dui-jia/
    history/
  components/          # 无云调用的复用视图
    ui/                # Button、Sheet、反馈、Input等
    cards/             # 球号牌与网格
    scores/            # 数字、成员分数、结果预览
  modules/
    cloud-client/      # 调用、错误归一化、运行时响应校验
    room-session/      # 快照、监听、生命周期与版本合并
    mutation/          # 请求身份、同请求重试、提交互斥
  stores/              # Zustand：身份、房间会话、待确认请求
  styles/              # tokens、基础样式、安全区
  assets/cards/        # 经小程序兼容验证的卡牌资源
packages/shared/src/
  contracts/           # 命令与查询DTO、错误码、运行时schema
  scoring/             # 精确计分与展示单位转换
```

依赖方向：Page → Feature → Module/纯视图 → shared。基础视图不能调用Feature；shared不能依赖Taro、React或微信SDK。只有cloud-client和room-session的微信Adapter接触平台网络/监听能力，页面不得直接读写集合。

每个Feature对外只有一个主视图和所需的控制Hook；不暴露每个状态setter。Module的Interface包含参数、前置条件、错误和清理规则，不能只写TypeScript类型而遗漏使用约束。

## 3. 数据和状态设计

### 3.1 三类状态分开

| 状态 | 存放位置 | 生命周期与约束 |
| --- | --- | --- |
| 服务端状态 | Zustand房间会话store，由room-session Module驱动 | 房间、活动、本人牌/公共牌、分数、能力配置；只有成功响应或可信快照更新 |
| 输入状态 | Feature内部useReducer/useState | 基础分字符串、赢家、转入选牌、表单错误；不写共享累计 |
| 请求状态 | mutation Module驱动Zustand请求store | idle/pending/succeeded/failed/unknown/conflict；与业务分数分开 |

输入字符串`""`、`"-"`、`"0"`必须区分；只在完整可解析时产生计分预览。所有分数存整数Units及scale，组件通过统一格式化器展示，禁止`parseFloat × 底分`直接记账。

### 3.1.1 Zustand的Module设计

| Store | 状态与动作 | 职责边界 |
| --- | --- | --- |
| identityStore | 当前userId/展示资料、恢复状态、replaceIdentity/reset | 不存openid、凭据或其他用户完整资料；换身份清理关联会话 |
| roomSessionStore | 当前roomId、快照、连接状态、generation、applySnapshot/reset | 原子替换一致快照；版本检查在动作内部统一执行，不让组件逐项set分数 |
| mutationStore | 按身份/房间/资源索引的pending、unknown、成功收据及请求元数据 | mutation Module负责真实请求，store只描述状态，不自动重放未知命令 |

store使用Zustand的`createStore`定义，React通过`useStore(store, selector)`订阅；提供应用级实例，另导出工厂供测试隔离。组件只订阅所需字段，不能默认订阅整个store；多个字段优先稳定selector或shallow比较，避免selector每次创建新引用造成无意义渲染。

快照中的本人牌、公共牌和分数保持同一次版本的一致性；不为不同玩法各复制一套独立可改的累计。差额、已记录数量、排序手牌由selector推导，不重复持久化。切房先取消旧监听、递增generation并清理旧快照；迟到响应无法写入新会话。

云调用、监听句柄、定时器、Promise保留在Module内部，不写入可序列化store。React Context不再承担共享业务状态；后续如使用Context只用于实例注入，不建立第二份状态来源。

不使用浏览器localStorage作为默认持久化方案。仅待确认请求需要持久化时，使用Taro Storage Adapter、版本化schema及用户/房间命名空间；不持久化手牌或把缓存当可信成绩。全局弹窗开关、号码选择、未保存的扑克系数默认仍为Feature局部状态，避免过度全局化。

### 3.2 RoomSession Interface

```ts
useRoomSession(roomId): {
  snapshot: RoomSnapshot | null
  status: 'loading' | 'ready' | 'stale' | 'offline' | 'error'
  refresh(): Promise<void>
}
```

Implementation负责快照获取、通知订阅、重复刷新合并、旧响应丢弃和生命周期。快照用`roomRevision + activityId + activityRevision`标识；不同activity的revision不能直接比较。同一roomSession的请求有generation，切房/恢复后旧generation的结果禁止落入当前页面。

监听只发“需刷新”信号，不直接把数据库doc塞进UI。多个通知合并为单次刷新；刷新中收到新通知则完成后再拉一次。首次获取前/后建立监听并再校对一次快照，避免订阅窗口漏消息。服务端通知设计见后端文档第7节。

Taro页面onShow恢复订阅并刷新；onHide/onUnload取消监听、清理定时器，onShow重新拉取。任何监听和云调用超时都进入stale而非伪造0分。短时无推送且页面可见时允许低频鉴权刷新兜底，频率属于运行配置，不承诺具体延迟指标。

### 3.3 写入状态与mutation Interface

```ts
execute(command): Promise<CommandReceipt>
retry(requestId): Promise<CommandReceipt>
```

- 一次主动操作创建requestId，内容冻结；重试必须使用同ID同参数。修改参数后是新操作，不可复用旧ID。
- 按`roomId/activityId/resourceKey`互斥：同牌进球/撤销不并发，完整保存与底分配置不并发。不同资源可提交，九球不同快捷项可独立操作。
- 请求pending禁用对应触控区，成功后按服务端结果刷新，不同时“本地加一次”又“监听加一次”。
- 网络失败可能已提交，状态设unknown，文案“结果待确认，请重试查询”；通过原请求重试获取收据，不能当失败创建新ID重复扣分。
- 仅保存少量待确认请求元数据到本机存储，按身份/房间隔离、恢复后让用户查询同请求；不是离线计分队列，不自动补发新操作。含敏感牌信息的完整表单不跨身份保存。
- 返回业务冲突则清除pending、刷新对应资源，保留可修正表单；事务冲突不能自动换revision强行提交。
- 导航后完成的请求不得在新页面弹toast；收据仍可由原房间刷新恢复。

## 4. 功能逐项细分

### 4.1 F01 身份、首页及入房

| 子功能 | 输入 → 输出 | 具体处理与边界 |
| --- | --- | --- |
| 身份恢复 | 微信云调用 → Me DTO | 服务端识别openid；前端只获得userId及展示资料，不请求通讯录或手机号 |
| 创建模式选择 | 点击创建 → 五玩法面板 | 默认未选；确认前不发创建请求；取消不产生房间 |
| 创建提交 | selectedMode + requestId → roomId | 成功才展示房间码；失败保留选择；unknown沿用原请求确认 |
| 房间码查询 | 规范化code → RoomPreview | 仅展示加入所需元数据，不拉取手牌或流水；输入变化时清空旧预览 |
| 加入确认 | code + requestId → membership | 分享入口与手输码使用同一JoinFeature；不再要求选模式 |
| 最近房间 | 分页查询 → RecentRoomCard[] | 读取后端成员关系和历史访问；不是本地假房间列表；失效显示真实状态 |

分享调用微信原生分享入口，分享路径携带join code；分享成功不表示对方已加入。前端不把可猜房间码当作身份凭证。首次资料设置按服务端能力呈现，姓名重名仍以userId区分。

### 4.2 F02 房间与活动准备

RoomShell承载房间标题、模式、房间码、成员、记分/记录/累计三个内部视图，不为每次切标签创建新activity。

房间已选mode但未满足人数时展示等待与邀请；创建房间不会自动用一名创建者开始活动。准备面板确认固定参与名单；扑克底分在开始计算前必填。服务端返回`capabilities`（可启用人数、已配置快捷值、允许的操作），前端不能自行填补两人九球或四人杀球未定规则。

切玩法使用roomRevision保护；若有本地输入或未完成牌局则先说明保留/离开影响，不静默清空或归档。暂停与恢复旧活动入口在生命周期规则明确前不自行实现。创建/切换后的名单、底分、scale以新活动配置为准，历史详情始终读快照。

### 4.3 F03 九球

数据输入：参与者摘要、本人成绩、服务器shortcuts[]、最近流水。输出命令：`nine.addDelta{shortcutKey,direction}`，不发送可信目标用户或最终分值。

1. MemberScoreStrip展示当前板分数；本人操作区渲染配置中允许的项。
2. 点快捷项一次execute；三人大金正项显示+20、负项−10，不能做成对称±10。
3. pending局部禁用，成功后分数取快照；差额为当前活动net之和，与其他玩法无关。
4. 不渲染杆次、上下家、逐局开始/结束、选输赢双方；他人成绩卡不提供改分入口。
5. 历史撤销P05未确定，不把杀球进球撤销组件直接用于九球改账。

### 4.4 F04 杀球：拆为六个子流程

| 子流程 | 视图/状态 | 命令与边界 |
| --- | --- | --- |
| 发牌 | undealt/dealing/dealt | `kill.deal`，一次成功生成统一牌组；已发牌无覆盖入口；四人少牌策略缺失则显示未配置 |
| 个人手牌 | MyHandGrid | 只读本人cards，升序，已进仍占原格；他人只读剩余数摘要 |
| 标记进球 | HandCard pending→potted | `kill.setPotted{number,potted:true,expectedCardRevision}`；点击已进牌面无操作 |
| 撤销进球 | UndoControl | 相同命令potted:false；独立44px触控区，不能当转归回退 |
| 惩罚转入 | 空白＋牌→TransferPicker | 候选1—15，自有禁选；单选确认后`kill.transferIn`，目标隐含本人 |
| 结果 | KillResultSheet | 选赢家，预填各输家当前剩余数且允许核对；保存完整结果，不自动开下一轮 |

TransferPicker仅接收`{number,selectable,revision}`候选，不默认获得他人owner或potted状态；操作依然依赖服务器候选版本，冲突刷新重新选，不能盲重放。取消面板无副作用。成功后两个用户数量一起从新快照更新，不在UI手动加减猜测。

`kill.setPotted`和`kill.transferIn`不增加房间输赢；只有`kill.saveResult`入累计。结果保存成功后牌面转只读并保留，不能一边修改同轮牌一边重复保存结果。“下一轮”策略待P10，UI预留成功态而不擅自自动发牌。

预填与手工核对分开：表单保存服务端返回的`resultInputVersion`及activityRevision，提交时配置或牌状态变化提示重新核对，不能用旧预览覆盖新剩余数。程序不验证线下惩罚成立与否。

### 4.5 F05 打分

- PlayerScoreStrip显示三家当前earnedPoints，基准40与最终输赢分分开标注；未来配置其他人数时不硬编码40。
- PublicCardGrid固定15张、三列五行；未归属点击直接`point.claim`给本人，pending以牌号定位。
- 已归属点击OwnershipSheet，显示归属、首次记录者、最近修改人；退回或改给本活动成员时提交expectedCardRevision。
- 进度从可信牌状态计算已分配张数与总进球分；15张齐才允许预览完整结果。
- `point.saveResult`成功锁定当前完整结果、显示保存摘要；不同人同时保存以服务器唯一结果为准，不重复计入累计。
- 页面不支持未完成“强行结算”、不自动传球给别人；posted后的更正P05明确前不展示可执行入口。

### 4.6 F06 打大A

模块分为ParticipantCoefficientForm、BaseStakeSummary、ResultPreview、SaveResultAction。五人输入顺序按活动participants，使用签名数值字符串；最终分采用共享精确公式计算。底分只读活动快照，不允许页面临时改个底分直接提交旧活动。

基础分包含线下已决定的明A等倍率，不额外翻倍。全员填完、可解析才显示可保存预览；仅预览不发业务写入。非零和策略由capabilities标明`allowWithWarning/block`；未配置时提示尚未配置，不默认让页面决定。没有主A、名次或自动规则表单。

保存成功展示单条结果；再算一次沿用名单/底分但清空数值，并获得新的resultToken。不能保留上一笔系数和请求身份误发成新结果。

### 4.7 F07 打对家

MultiplierPicker允许1/2，WinnerPicker要求正好两名不同参与者；剩余两人自动作为输方。所有选择完成才预览，按照每人倍数×底分计算，不把总分再平分。

保存命令只含winnerUserIds、multiplier和resultToken，不接受客户端postings。再算一次清空赢家与倍数，保留配置。不维护长期搭档关系。

### 4.8 F08 记录和累计

- useHistoryQuery按roomId/mode/cursor隔离缓存；切玩法取消旧请求，稳定游标分页，避免时间相同漏记录。
- EventRenderer按kind区分：九球一人变动、杀球及扑克完整结果、打分最终结果和修改详情。不能将过程牌事件当累计结果再相加。
- 历史名字、底分、scale来自事件快照，不能拿当前资料覆盖旧值。当前累计来自服务端投影，不在页面把已加载的部分历史求和当总成绩。
- 空态、加载失败、末页分别展示；未开放更正前不提供假的删除/撤销按钮。

## 5. 可复用视图与业务Module

### 5.1 组件化清单

| 名称 | 最小Interface | 复用位置 | 明确不包含 |
| --- | --- | --- | --- |
| ActionButton | label, status, disabledReason, onPress | 全部提交入口 | 发网络请求、自己生成requestId |
| BottomSheet | open, title, onClose, children, busy | 模式/转归/结果/归属 | 保存业务；busy关闭策略由调用方提供 |
| AsyncStatePanel | loading/error/empty/stale, retry | 首页、房间、记录 | 判断房间有效性 |
| PlayerIdentity | userId,name,isMe,avatar | 所有成员展示 | 用name作为React key |
| ScoreValue | units,scale,unit,tone | 分数卡、预览、历史 | 浮点计算、累计 |
| MemberScoreStrip | entries,metric | 九球/打分/累计 | 改分入口；earned与net由调用方显式选 |
| NumberCardFace | number,visualState,ownerLabel | 杀球、打分 | 归属业务、自动判断进球 |
| CardGrid | columns,gap,children | 杀球手牌、公共牌 | 私密数据过滤 |
| SelectionGrid | items,selected,max,onChange | 模式、赢家、转入 | 网络提交 |
| SignedNumberInput | rawValue,precision,onChange | 大A、底分 | 把未填当0、提交时自动舍入 |
| RemainingInput | rawValue,onChange | 杀球结果 | 限制初始牌数为上限 |
| ResultPreview | participantDeltas,scale,unit | 杀球、打分、两种扑克 | 保存、二次计算分值 |
| SaveResultAction | state,canSave,onSave | 完整结果入口 | 统一强制结束所有玩法 |

HandCard由NumberCardFace + UndoControl组成；PublicCard用NumberCardFace + OwnershipBadge组成；PenaltyAddCard是独立入口，不伪装成第16个可领取号码。

不建“万能牌组件”包含发牌/转归/公共领取三套业务，也不建一个用数十个boolean驱动的万能计分页。复用视觉外壳和mutation能力，玩法保持独立Feature。

### 5.2 Module深度与Interface约束

| Module | Interface | 内部隐藏复杂性 | 测试入口 |
| --- | --- | --- | --- |
| CloudClient | query/command | 微信回调、返回schema校验、错误映射、requestId透传 | 同一Interface替换受控云调用Adapter |
| RoomSession | snapshot/status/refresh | 监听、生命周期、通知合并、版本竞态 | 快照与通知事件序列 |
| Mutation | execute/retry | 幂等请求身份、互斥、unknown收据恢复 | 超时后重试同请求 |
| SharedScoring | 纯函数计算与格式化 | 安全整数、单位、系数乘法、玩法公式 | 真实函数输入输出 |

外部Interface不暴露数据库集合、watcher实例或React内部setter；测试跨同一Interface验证实际行为，不复制计算实现做断言。

## 6. 接口契约与错误

详细命令清单及事务见[后端设计](./BACKEND.md)。统一DTO和Zod schema放shared/contracts，前端按action调用，不复制手写类型。

活动写入公共字段：`requestId, roomId, activityId`；牌操作带cardRevision，杀球/打分完整结果带activityRevision，两种扑克结果带configRevision与resultToken；创建房间只需requestId+mode。查询不带requestId。

成功返回CommandReceipt中的eventId/实体ID/提交版本，不将收据内旧成绩覆盖新快照。错误增加可区分的`ALREADY_POSTED / RULE_NOT_CONFIGURED / STALE_CONTEXT / IDEMPOTENCY_MISMATCH / RATE_LIMITED`；网络unknown是客户端传输状态而非一个业务失败码。

| 错误 | 前端行为 |
| --- | --- |
| INVALID_ARGUMENT | 定位字段，保留输入 |
| UNAUTHENTICATED | 恢复身份后查询原请求，不自动新建操作 |
| FORBIDDEN / NOT_FOUND | 停止订阅并展示返回入口，不在后台持续重试 |
| CONFLICT / STALE_CONTEXT | 刷新并要求核对，不自动覆盖 |
| ALREADY_POSTED | 展示已有结果，关闭保存入口 |
| RULE_NOT_CONFIGURED | 显示对应能力暂不可用，不猜默认参数 |
| RATE_LIMITED | 显示稍后重试，不循环发起请求 |
| INTERNAL_ERROR | 保留输入，允许用原请求ID查询重试 |

## 7. V4素材和样式实施

- 颜色与间距以`docs/design/v4-handoff/tokens.json`为源，生成到styles/tokens；不直接修改设计交付包。
- 设计宽390px。推荐Taro配置designWidth=390，手写样式按稿px，由编译器换算；若维持750方案则在生成阶段按750/390换算。两条路径只能选一条，推荐前者，避免素材尺寸被转换两次。
- 自定义顶部导航读取真实安全区与胶囊位置，或使用原生导航并移除示意占位；不把HTML的36+52或假胶囊写进生产界面。
- 卡牌优先View+Text明确显示号码和角标；若直接用SVG必须先验证微信兼容，否则导出本地PNG。无论图片是否加载成功都保留号码文本与可操作名称。
- 本人牌三列、约111×144逻辑px；公共牌三列五行、约114×60；杀球每行预留撤销触控间距48，已进标签不换行；转归面板最大85%高度，内容可滚动。
- 触控最小44×44为实际逻辑px约束，320宽与大字体不得按缩放后过小的rpx名义尺寸通过验收。页面允许纵向滚动，不锁844px画布。
- V4仅有三屏，九球、扑克、记录页复用同一token与组件，不新增未经说明的视觉资源。

## 8. 验证计划与实施拆分

| 实施阶段 | 交付 | 验收重点 |
| --- | --- | --- |
| FE-1 | shared DTO、CloudClient、Mutation、基础视图/token | 类型检查；超时、重复提交、单位转换 |
| FE-2 | 首页、先选模式创建、加入、房间Shell和Session | H01—H06；订阅清理与重新进入 |
| FE-3 | 杀球与打分 | K05—K16；S01—S04；320/390/430视觉与V4对照 |
| FE-4 | 九球与两种扑克 | N/A/D验收；未保存累计不变 |
| FE-5 | 历史、累计、失败恢复 | 多人并发、断线重试、分页与历史快照 |

视图测试选择有交互风险的地方：杀球已进牌不重复提交、撤销只恢复进球、转归取消无副作用、打分冲突、创建前模式未选不能提交。纯颜色和低风险布局不写镜像测试，使用实际渲染及真机走查。

多人端到端需真实开发环境验证：A记分B同步；双方抢同牌；响应丢失后重试；完整结果跨用户重复保存；切房后迟到响应不污染新房间。构建通过不等于这些验收已通过。

## 9. 边界与交付状态

目前已有可构建前端骨架和V4本地原型，本文设计尚未实施。P01—P10通过能力配置隔离；未确定的转归回退、重发牌、历史冲正不因预留按钮而开放。不得为等所有业务决策而停止开发已确定的主页、三人杀球、三人打分和基础同步。

本次仅新增技术文档，不复制prototype.js、不更改原始设计包、不宣称真机或多人测试完成。
