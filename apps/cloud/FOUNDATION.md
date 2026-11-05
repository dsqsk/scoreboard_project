# 身份、房间和活动准备：联调说明

日期：2026-10-21。实现入口为 `functions/api/index.ts`，独立于health。api已通过CLI部署为Event函数，云端Active且参数校验调用通过；微信身份及数据库业务链路尚未联调。

## 本轮范围

- 可信云调用身份解析；相同AppID/OpenID映射稳定内部userId，不接受请求指定openid。
- 资料查询/更新；首次稳定生成默认昵称/头像颜色，旧未完成资料逐步补齐；资料变化不重写活动历史姓名快照。
- 先选择mode再创建房间，生成六位房间码，自动加入创建者。
- 房间码最小预览、加入、最近20个房间、成员分页、当前快照。
- 选择模式与准备活动；固定成员、冻结配置、初始化活动成绩和必要公共牌/结果槽。
- 幂等收据、成员授权、AppID隔离、版本冲突、码查询/创建限流、事务回滚。

后续已实现并部署两人或三人打分的认领、修正、结果结算、历史及累计，接口与分页见 [打分交接](../../docs/development/POINT-BACKEND-HANDOFF.md)，真实微信业务链路仍待联调。其他玩法的发牌、记分、结果结算及通知投递worker未实现。已保存notification_outbox待投递任务和signal占位，不能将此阶段视为已完成实时同步。客户端可调用快照查询联调，不要直接监听私密业务集合。

## 请求格式

```ts
Taro.cloud.callFunction({
  name: 'api',
  data: {
    action: 'room.create',
    requestId: 'create_550e8400-e29b-41d4-a716-446655440000',
    payload: { mode: 'kill_ball' }
  }
})
```

成功：`{ok:true,data:...}`。失败：`{ok:false,error:{code,message}}`。查询不带requestId，写操作必填8—100位字母、数字、下划线或连字符；重试同一操作沿用同ID同参数。其他字段严格校验，不接受未知action或字段。

| action | payload | 返回data |
| --- | --- | --- |
| identity.getMe | `{}` | `{userId,displayName,avatarFileId}` |
| identity.updateProfile | `{displayName,avatarFileId?}` | CommandReceipt；avatar仅cloud://资源或null |
| room.create | `{mode}` | `{requestId,entityId,roomId,roomRevision,joinCode}` |
| room.preview | `{joinCode}` | `{roomId,name,displayName,joinCode,selectedMode,memberCount,status}`，不含成员、分数或牌 |
| room.join | `{joinCode}` | CommandReceipt，重复加入不增加memberCount |
| room.listRecent | `{}` | 兼容数组：本人未隐藏的有效房间，跨过滤扫描页补足最多20个 |
| room.listRecentPage | `{cursor?,limit?}` | `{rooms,nextCursor}`，每房含lastEnteredAt；空页仍可能有游标，须继续补位 |
| room.enter | `{roomId}`，带requestId | CommandReceipt；主动进入恢复本人最近条目并更新时间 |
| room.dismissRecent | `{roomId}`，带requestId | CommandReceipt；仅本人持久隐藏，不退出或删除房间 |
| room.listMembers | `{roomId,cursor?,limit?}` | `{members,nextCursor}`，默认20、最多20，游标原样回传 |
| room.getSnapshot | `{roomId}` | 房间摘要、revision、首20个members及membersNextCursor、activity、scores、cards、signalDocumentId |
| room.selectMode | `{roomId,mode,expectedRoomRevision}` | 更新所选mode；不自动开始活动 |
| activity.prepare | `{roomId,expectedRoomRevision,participantIds,configInput?}` | `{requestId,entityId,roomId,roomRevision,activityId,activityRevision}` |

`mode`：nine_ball、kill_ball、point_ball、da_a、dui_jia。共享schema及Foundation DTO在`packages/shared/src/contracts/foundation.ts`，已有前端RoomApi类型继续位于room.ts，避免基础房间页强依赖活动细节。

room快照为兼容既有前端同时返回name/displayName和revision/roomRevision；两组值由同一服务端字段派生，不是两份独立状态。members.joinedAt使用ISO字符串；数据库时间使用可信云函数生成的epoch毫秒，客户端不能指定。

## 推荐联调顺序

1. 每个人调用identity.getMe取得自身userId；首次自动生成并持久化词库昵称和person-v1默认头像颜色，可用updateProfile自选修改，不自动读取微信个人资料。
2. 创建者调用room.create选择玩法，其他人通过room.preview/room.join加入。
3. room.getSnapshot获取roomRevision与首批成员，超过20人通过room.listMembers继续取。
4. 从真实成员中选择固定参与名单；必须包含调用者。调用activity.prepare带当前roomRevision。
5. 再取room.getSnapshot验证活动配置。准备不会产生任何输赢分、不会自动发牌。
6. 网络结果未知时以原requestId重试，返回原收据；同ID更换参数返回IDEMPOTENCY_MISMATCH。旧版本准备返回STALE_CONTEXT。

```json
{
  "action": "activity.prepare",
  "requestId": "prepare_550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "roomId": "使用实际roomId",
    "expectedRoomRevision": 2,
    "participantIds": ["使用实际userId1", "使用实际userId2", "使用实际userId3"],
    "configInput": {}
  }
}
```

## 当前能力与未定规则隔离

| 玩法 | 当前准备能力 |
| --- | --- |
| 三人九球 | 快捷值4、7、1，三人大金+20/−10，让杆8/14，均为配置快照；不执行记分 |
| 两人九球 | 可准备，普胜/小金/犯规可配置；大金及让杆未定，unavailableShortcutKeys明确标记 |
| 三人杀球 | 准备5/5/5分配计划、undealt状态；不创建假牌、不显示剩余0冒充已发牌 |
| 四人杀球 | 返回RULE_NOT_CONFIGURED，避免擅自指定谁拿3张 |
| 打分 | 支持两人或三人；准备15张owner=null牌、进球分0，基准120/本场人数（60或40），新活动规则版本point-ball-v2 |
| 打大A/对家 | 5人/4人，configInput必填baseStake字符串；创建一份共享open结果槽 |

底分的工程默认格式为正十进制字符串，最多两位小数、整数部分最多12位；存储固定100倍Units，使用BigInt解析避免0.29等浮点误差。此为可调整的工程输入策略，尚不是用户对P04全部业务边界的确认。不能由客户端指定scale或快捷值。大A非零和保存策略仍标not_configured，本轮不实现存账。

进行中的活动不允许覆盖或静默换模式。只有旧活动posted/archived后才可准备新活动；本轮没有“强制结束九球”或重发牌接口，等待后续活动生命周期实现。

晚加入者只增加房间成员，不改变当前活动名单/打分基准（固定参与人数，两人60、三人40）。非参赛成员可以看公开分数、公共牌与房间结果，不得到杀球他人手牌。用户资料中微信标识、commands收据和rate_limits从不向其他成员返回。

## 部署准备

1. 根目录 `npm ci`，执行 `npm run typecheck`、`npm run test --workspace @scoreboard/cloud`、`npm run build:cloud`。
2. 在测试云环境预先创建database/manifest.json列出的15个集合，并配置列出的成员查询复合索引。当前prod环境15个集合和2个成员查询索引已初始化。该文件是清单说明，不是可执行迁移或CloudBase官方部署配置。
3. 本轮所有集合的客户端读写权限均设为false；云函数SDK由应用层做授权。尤其不能因联调方便将users、成员或牌集合设为所有人可读写。
4. 上传 `apps/cloud/dist/api` 和health，云端安装依赖。api必须经真实微信小程序调用才能验证身份，控制台伪造payload.openid无效。
5. 以至少两名真实微信用户验证create/join/prepare及无权限读取；使用测试环境验证并发事务。内存测试不证明云数据库锁、索引、配额或真实并发行为已验收。

通知worker接入时再单独验证signal的仅本人可读规则和watch行为，本轮不提前放开客户端监听权限。

限流默认：每用户每分钟最多10个不同创建请求，30个房间码查询/加入请求；同一命令同参数重试不重复计数。限流桶每用户每操作组固定一条，窗口轮换复用，不无限累积每分钟文档。业务事务失败不会产生房间/活动半记录；身份创建和限流计数是独立事务，可单独保留。

## 本地验证

服务测试使用串行事务MemoryStore Adapter验证业务、原子回滚和幂等，SDK Adapter测试验证事务透传、缺失文档读取、写入排除_id及异常传播。真实云环境/多人微信并发尚未执行。

## 控制台上传注意

api使用Event事件函数类型和index.main入口，不能选择需要scf_bootstrap的HTTP/Web类型。建议先执行 `npm run build:cloud`、`npm run check:cloud-package`，再通过CLI部署指定api。完整云端状态与验证记录见 [接入说明](../../docs/technical/CLOUDBASE-SETUP.md)。

## 最近房间补充（2026-10-22）

getSnapshot已改为只读，不更新成员lastVisitedAt。进入房间时显式调用room.enter，轮询/重连不能调用。创建和新命令join也恢复最近条目。成员recentHidden缺失按false兼容，无需迁移。字段、分页预算与旧收据恢复的精确语义及部署证据见[最近房间后端交付](../../docs/development/RECENT-ROOMS-BACKEND.md)。
