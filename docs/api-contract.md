# 打大A接口

调用api Event函数；响应沿用ApiResult。写命令requestId为8—100位字母/数字/_/-，结果未知复用原ID及原载荷；未知字段拒绝。actor只取可信微信身份，不接受userId、金额、底分或全员postings作为记分写入参数。

| action | payload | data |
| --- | --- | --- |
| daA.createRoom | {baseStake:1或5或10} | CommandReceipt，含roomId、joinCode、roomRevision |
| daA.prepare | {roomId,expectedRoomRevision,participantIds} | CommandReceipt，含activityId、activityRevision |
| daA.addDelta | {roomId,activityId,expectedConfigRevision,direction:1或-1,value:1或2或3或4或6或8或16或32,mingA:boolean} | CommandReceipt，entityId为entryId，含roomId/activityId |
| daA.getState | {roomId,cursor?} | DaASnapshot |

DaASnapshot：roomId、roomRevision、baseStake(1/5/10)、scoreScale=100、activity(null或{activityId,configRevision,revision,status,participants})、canRecord、entries、nextCursor(string或null)、totalsUnits(按userId映射整数累计)。participants使用冻结Me快照。无活动时canRecord=false、可读房间底分/历史/累计；非本场成员canRecord=false但有效房间成员可读。

entries每条：entryId、requestId、roomId、activityId、userId、displayName、direction、value、baseStake、mingA、deltaUnits、savedAt(epoch毫秒)。最新在前，每页最多20条；cursor表示下一条记录ID并绑定房间权限，前端原样回传。历史跨活动保留；totalsUnits始终为房间完整累计，未记分者缺省0，不能用当前页重算。

prepare必须包含本人、恰好5名不同有效成员，冻结创建时底分；不能覆盖进行中活动。addDelta不使用全局activityRevision挡住不同人的独立加分；检查当前活动、固定名单及configRevision。服务器计算direction×value×baseStake×(mingA?2:1)×100，同ID同载荷只记一次，不同ID为独立确认。

错误：INVALID_ARGUMENT非法参数；FORBIDDEN非成员/非参与者；STALE_CONTEXT旧活动/旧配置/玩法改变；RULE_NOT_CONFIGURED底分或旧规则不支持；CONFLICT活动冲突或溢出；IDEMPOTENCY_MISMATCH同ID异载荷。已成功旧命令优先恢复原收据，不应用到新活动；有效身份及同App访问仍必须校验。

共享DTO及Zod位于packages/shared；后端维护，前端只消费。契约实现需变更时先改本文件及任务约束，禁止仅在聊天变更。

## 点数认领/更正的确认回执（2026-10-23）

point.claim与point.correct成功返回的CommandReceipt新增可选pointState字段（兼容旧回执/旧客户端），新执行必须返回：

- PointCommitState = {activityId,revision,status:'open',cards:PointCardDTO[15],earnedPoints:Record<userId,integer>,change:PointChange}。
- pointState.activityId/revision必须等于外层activityId/activityRevision；change.requestId必须等于外层requestId；号码、归属与提交命令一致。cards为本次事务写入后的完整当前15牌投影，earnedPoints由同一投影计算，不含历史分页、累计或成员查询。
- commands.result事务持久化完整回执；重放返回原回执，不能按当前状态重造旧回执。历史无pointState回执保持兼容。
- FE PointApi.execute返回CommandReceipt或void（旧Mock兼容）。新claim/correct收到有效pointState后应用当前牌面并结束等待，不立即再调getState；prepare/post和旧回执仍走兼容刷新。
- 仅匹配当前房间/活动且不低于当前房间/活动版本的投影可应用；旧响应不得覆盖新牌面。change按requestId去重追加到已加载历史，不改变历史分页游标。客户端校验15牌、归属/积分一致性及命令绑定，不信任类型断言。
- 超时/非法回执继续按未知结果保存原请求ID；不产生新命令。前端仅对在途牌显示明显的待确认反馈，未确认结果不进入已确认成绩。


## 单机HTTP传输迁移

接口路径、微信会话、维护响应、头像上传解析及开发IP约束统一见[HTTP迁移契约](./http-migration-contract.md)。业务action与原请求/回执DTO保持兼容；HTTP失败不得自动回写旧云端。当前仅隔离演练，正式源仍为旧云端。
