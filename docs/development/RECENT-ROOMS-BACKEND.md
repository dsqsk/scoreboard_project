# 最近房间后端交付

2026-10-22。依据RECENT-ROOMS-TASK、PRD HR01—HR06和home-recent-handoff/SPEC。后端独占维护cloud/shared，未修改miniapp；契约已在实现前同步前端。

## 请求与返回

| action | payload | 返回 |
| --- | --- | --- |
| room.enter | {roomId}，写命令带requestId | CommandReceipt：entityId=roomId、roomId、roomRevision |
| room.dismissRecent | {roomId}，写命令带requestId | 同上；房间已物理缺失时roomRevision可省略 |
| room.listRecentPage | {cursor?,limit?}，limit为1—20整数，默认20 | {rooms:RecentRoomPreview[],nextCursor:string\|null} |
| room.listRecent | {} | 保留旧数组接口，返回本人前20个有效未隐藏房间，内部持续分页补位 |

RoomApi新增enterRoom(roomId,requestId)、dismissRecentRoom(roomId,requestId)、listRecentPage(cursor?,limit?)。RecentRoomPreview继承RoomPreview，并包含必填lastEnteredAt（epoch毫秒）。写收据复用现有类型；查询不接受客户端userId，身份只从可信微信上下文获取。

## 分页边界

- 按成员lastVisitedAt倒序、成员_id升序进行键集分页，不用offset。游标opaque、带版本和本人绑定校验，前端原样回传；非法或跨用户游标INVALID_ARGUMENT。校验不是授权替代，数据库始终限定actorUserId和有效成员状态。
- 每页最多扫描40条原始成员关系，每批最多20条，过滤隐藏、关闭、过期、缺失、跨App房间后再组装可见条目。**rooms可能不足limit或为空，但只要nextCursor非null就必须继续加载，直到补足首页3条或游标耗尽。**“全部”按同一语义继续分页，不能把第一页当全部。
- 扫描预算避免无限事务和一次性读取所有历史；旧数组接口会跨扫描页填足20条或读取到末尾，不在20条原始关系处截断。
- 相同时间用稳定成员ID排序；新进入/隐藏等并发操作下为实时列表，非冻结快照。主动进入把房间移至边界之前时，继续旧游标不会重新扫描该新顶部条目；刷新首屏获取最新排序。客户端按roomId去重，防迟到旧列表覆盖已确认移除。

## 可见性、进入与幂等

- room_members新增recentHidden?:boolean，缺失视为false。只改调用者自己的成员文档，不退出、删成员或房间，不修改memberCount、活动、牌、结果、累计或其他用户关系。
- dismiss不改变lastVisitedAt；重复隐藏不额外改成员版本，仍保存请求收据。
- create、有效room.join（包括已经加入者）和room.enter置recentHidden=false并更新本人lastVisitedAt。新命令主动进入更新排序；原ID同参数只取原收据，不重新更新或恢复。
- getSnapshot不再更新lastVisitedAt、隐藏标记或成员revision；point快照/记分、房间内容更新不改变最近顺序。前端首次主动打开显式enter，轮询/重连/useDidShow刷新不得重复enter。
- 最近列表仅展示有效房间；关闭/过期/缺失房间过滤。dismiss允许清理本人这些旧关系，只要求有效用户和该关系归属；enter必须有效房间和有效成员。其他App拒绝。
- 恢复旧enter/join/dismiss收据时先验证用户有效身份和命令摘要，再返回本人旧收据；新命令才验证当前房间/成员/房间码状态。即使后来房间关闭，旧请求也可确认结果，不重做进入。其他领域命令授权策略不变。
- 同ID异载荷IDEMPOTENCY_MISMATCH。收据与个人可见性同事务，持久化失败整体回滚；未知结果必须原ID恢复。不同设备新命令并发时以成功提交的最终成员状态为准。

## 字段、索引与兼容

只新增可选recentHidden，沿用lastVisitedAt表示主动进入时间；旧值作为升级时的排序基线，不能追溯还原旧版本曾由快照更新过的进入时间。无需新集合、批量迁移或改权限，业务集合继续ADMINONLY。

复用现有room_members复合索引user_status_recent_id：userId asc、status asc、lastVisitedAt desc、_id asc。SDK续页分为“同时间且ID更大”和“更早时间”两段索引范围；无需依赖缺失字段的neq语义，也不需要新隐藏字段索引。

## 验证与状态

- 本地：42项后端测试通过，含35项既有回归、6项recent服务集成场景和1项SDK续页范围测试；全仓typecheck、build:cloud、check:cloud-package通过。
- 覆盖：45条隐藏数据跨空扫描页补位、旧数组补足20条、全部25条可见分页、同时间稳定ID排序、跨用户/非法游标、快照不改排序/不复活、原ID旧enter/join不复活、新ID主动恢复、活动/牌/成绩/他人成员资格不变、收据失败回滚和重开持久、关闭/过期/缺失清理及进入拒绝。计分后的后台内容变化也不修改本人可见性/排序。
- 部署：api已更新至scoreboard-d7giv4iri8369fe43，云端Active/Event/Nodejs20.19/index.main，FunctionVersion=`$LATEST`，平台ModTime原值`2026-10-22 15:56:45`（按返回原值记录，未换算时区）。源码确认包含新action和40条扫描逻辑，且getSnapshot函数段不含room_members写入。现有user_status_recent_id索引字段/方向已回读核对，无需新索引或权限变更。
- 管理端入口探测：room.listRecentPage {limit:3}进入正常身份校验，InvokeResult=0、ErrMsg为空、业务UNAUTHENTICATED；请求b134dd21-e312-4885-a3fb-8cdf5f15ae45。仅证明启动/schema/身份拦截，不证明真实成员读写。
- 真实微信尝试：官方automation_evaluate与之后currentPage只读检查均返回Remote debug connection lost，属于开发者工具运行时不可用，未得到业务返回。管理端两次核对recent_probe_创建收据均为空（末次ea6a84e8-bdef-49a8-9d6b-637306a21d39），不能把该尝试写成真实业务通过。没有伪造微信用户或清空既有数据。
- 已与前端约定单一模拟器控制者，后端停止切页/刷新，前端可在恢复后做微信单用户验证。真实微信/双账号列表隔离、左滑手势仍待验收，以前端后续证据为准。
- 保留apps/cloud/scripts/probe-recent.wx.js作为单次原生Cloud探针：固定前缀recent_probe_backend_20261022_v1，各命令ID可追踪；如运行中断，先查询原收据恢复结果，勿直接换ID重发。探针计划创建一个空活动房间，验证完成后只隐藏本人该条目，不删房间数据。此前失败尝试使用动态recent_probe_前缀；未发现已提交创建。
