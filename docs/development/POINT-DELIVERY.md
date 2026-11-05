# 2026-10-22 规则变更：支持两人或三人打分

本节覆盖下文旧版三人限制。活动参与者支持2～3人，120分按本场固定名单平分：两人每人60分，三人每人40分。净分=进球分−120/本场人数。

- 准备面板必须包含本人、成员不重复且均属于房间；少于2人或超过3人不能开始，选满3人后禁止继续添加。
- 比分区按2列或3列展示；准备说明、结果预览和历史卡片均显示对应底分。
- 后加入成员不改变当前名单和底分；下场可重新选择2人或3人。
- 历史每条记录按自身参与人数校验和展示，可混合保留两人和三人结果；累计只累加已保存净分，继续保持零和。
- 15张完整且合计120分才能保存；原有权限、幂等、冲突、断网和未知结果恢复边界不变。
- 后端同步检查activity.prepare人数、config.baselineUnits、point.post扣减、规则版本及测试；前端不提交可篡改的底分。

以下保留首次三人版本交付记录，仅用于追溯：

# 打分功能：前后端交付与异常边界

2026-10-21。依据 PRD 第6节、UI-UX 第8节、V4 handoff 的打分页。本次只实现已确定的三人版本；四人及其他人数/小数精度仍属P03，不擅自开放。

## 功能与权限

1. 未有活动时，确认包含本人在内的三名房间成员再开始。参与名单在活动内固定；晚加入者不能认领，但作为房间成员可查看并修正归属（PRD“所有成员可以退回或改归属”），目标只能是本场三人。界面明确说明本人未参加本场。
2. 当前进球分初始0，展示三名参与者、本人标记、已记录张数/15、已记录分数/120、个人基准40。展示1—15三列五行公共号码牌，号码即分值，14/15保留明确号码。
3. 点未分配牌直接归操作者，无选人弹窗。成功后增加本人当前进球分，不计入累计。
4. 已分配牌打开修正面板，显示当前归属与最近修改人；可退回公共区或改归本场另一人。一次事务扣原分、加新分，保留最初记录人和每次修改痕迹。
5. 15张全分配、合计120才允许主动保存。服务端自行计算每人进球分−40，结果合计0。一次保存三人完整结果并更新本房间打分累计；过程修改不记入累计。
6. 保存后牌和本次结果只读，不允许P05未定的结算后更正。显示保存摘要；记录页区分过程修改与完整结果，累计只计完整结果。
7. 保存后可“再来一次”，重新确认三人名单，产生新activityId，旧活动、记录和累计保留；不自动清空旧牌，不覆盖历史。多人同时开始只能有一个新活动。

## 已确认接口契约（与“后端”对话同步完成）

前端在 `features/point/api.ts` 定义可替换 PointApi，使用后端已导出的 shared PointSnapshot/PointChange/PointResult 契约。请求不发送可信操作者或最终成绩；身份来自微信上下文。

- `point.getState {roomId}`：返回 PointSnapshot，含当前活动或null、本房间全部打分结果、累计及当前活动过程记录。当前无活动允许返回null；当前房间其他玩法/不存在/非成员明确报错。
- 开始复用 `activity.prepare {roomId, expectedRoomRevision, participantIds, configInput:{}}`，必须仅允许3人，名单唯一且均为有效成员。Receipt后重读point.getState。初次开始和“再来一次”都携带打开准备面板时的房间版本，不允许并发替换。
- `point.claim {roomId,activityId,number,expectedCardRevision}` + requestId。只允许本场参与者认领未归属牌；本人由后端身份确定。
- `point.correct {roomId,activityId,number,expectedCardRevision,ownerUserId:string|null}` + requestId。房间有效成员可修改；非空目标必须在固定名单，空值退回公共区。原本未分配的牌不能用correct绕过claim权限。
- `point.post {roomId,activityId,expectedActivityRevision}` + requestId。仅本场参与者可保存；无需前端提交分数。完整性校验、三人成绩、历史及累计一次事务。

PointSnapshot主要字段（最终类型见 packages/shared/src/contracts/point.ts，时间为epoch毫秒）：
```
{ roomId, roomRevision,
  activity: null | {activityId, revision, status:'open'|'posted', participants:[{userId,displayName}],
    cards:[{number,ownerUserId:null|string,revision,initialRecordedBy:null|string,lastModifiedBy:null|string}],
    earnedPoints:Record<userId,number>,
    changes:[{requestId,number,fromUserId:null|string,toUserId:null|string,actorUserId,actorName,createdAt}],
    result:null|{activityId,participants:[{userId,displayName}],earnedPoints:Record<userId,number>,deltas:Record<userId,number>,savedAt}
  },
  results:[完整结果，最新在前], totals:Record<userId,number>,
  nextResultCursor:string|null, nextChangeCursor:string|null
}
```
当前活动15张cards唯一完整；版本为非负整数；三人名单固定。身份显示名在历史中保留当时快照。后端已采用独立分页：point.getState支持resultCursor/changeCursor，results和activity.changes分别每页最多20条，传回nextResultCursor/nextChangeCursor继续。只追加对应分页，不重复追加另一种首屏数据；前端不把第一页当成全部累计。totals为服务端独立汇总，不从一页历史推断。

## 异常与并发边界

- 数字范围1—15整数、成员身份、活动属于房间、玩法一致、三人名单、目标在名单均由服务端校验。
- 同牌并发：以expectedCardRevision保证仅一人成功，失败返回CONFLICT并提示重读当前归属；不同牌不应因活动整体版本变化互相冲突。每次卡操作更新cardRevision和activityRevision。
- 修改失败保持上次已确认牌/分；不乐观伪造成功。页面局部标识提交中，防重复；未知结果阻止其他写入直至确认原请求，防止依赖未知状态继续操作。
- requestId按用户、命令内容幂等；同请求同载荷返回原回执，不重复计分或累计；同ID异载荷IDEMPOTENCY_MISMATCH。超时/断网/无法解析写响应均为结果未知，持久化原请求，重开重试原ID。读回最新快照不等于允许换ID重发旧动作。
- 保存与修正并发：post带activityRevision，先修改则保存STALE_CONTEXT/CONFLICT；先保存则修改ALREADY_POSTED。保存结果必须对应某个一致快照。
- 未齐15张、合计不为120、归属不在名单均拒绝保存。保存同活动即使用不同requestId也不得重复累计。
- 错房间/旧activityId/已切玩法/版本过期返回STALE_CONTEXT或CONFLICT，刷新并让用户重新确认，不静默把旧操作应用到新活动。
- 有效房间成员晚加入不改变固定名单或40分基准；可查看、修正，不能认领本人或保存结果。不得以room.members.length代替活动人数。
- 保存后“再来一次”只允许posted→新open；进行中不得重置。旧请求重试只能返回旧回执，不能清空新活动。
- 后端写入失败不可部分更新归属、分数、修改日志、结果或累计。
- 没有离线合并、自动犯规、自动判定最小号击球、自动结算；只读失败不显示虚构0分或空历史。
- 页面卸载/切房间忽略旧响应，清理刷新订阅。断网提示并在恢复后重读；不自动补发未确认写入。

## 验收用例

- A认领6、B认领9后进球分6/9/0，进度2/15，累计仍0。
- 同时抢6只有一个成功；不同牌可独立成功；重复点击/相同requestId不重复得分。
- 将A的6改给B，A−6/B+6且显示修改人；退回后扣6并保留修改痕迹。
- 不足15张不能保存；完整60/40/20保存+20/0/−20，重复保存不重复累计。
- 新成员加入，当前仍为原三人、基准40；新成员可修正到现有参与者，不能认领或保存。
- 保存与改牌竞态不产生不一致结果；结果保存后修改被拒绝。
- 丢响应、持久化失败、断网、重开、旧房间响应、旧活动请求和再次开始不覆盖原记录。
- 新一局重新确认名单，进球分回0但旧累计保留；过程修正日志与完整结果能分别核对。

前端仅修改miniapp及本交付文档；shared/backend由“后端”对话维护，避免同时编辑同一契约。云端部署或真实账号测试应由后端按其当前授权和环境流程处理，不能将本说明视为已部署完成。

## 同步与当前交付状态

“后端”已实现并部署四个action、activity.prepare衔接和三个新集合，详情见[后端交接](POINT-BACKEND-HANDOFF.md)。前端已按shared契约接入云端，另保留隔离Mock。真实微信三成员链路尚待验收；本地真实后端handler联调与DOM走查通过，不能替代云端多人并发验证。前端交付与测试见[第四步](FRONTEND-STEP-4.md)。
