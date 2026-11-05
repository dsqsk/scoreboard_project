# 打分后端交接（两人或三人）

最新进度：2026-10-21已完成部署。3个新增集合已创建并回读ADMINONLY；api状态Active、类型Event、Nodejs20.19、index.main。管理端探测发现旧ENV上下文依赖，已改用官方DYNAMIC_CURRENT_ENV，并通过runtimeCloud窄类型接口补齐社区声明缺失的symbol/init/database选项。再次调用point.getState返回预期UNAUTHENTICATED（管理端没有微信身份），平台InvokeResult=0、ErrMsg为空，请求ID：41efde00-6a39-4f01-8b71-2e25d6b80ddd。真实微信业务读写及并发仍待验证。

2026-10-21。接口及shared契约已实现、部署，本地测试已通过；不代表真实微信联调通过。

## 已确定契约

四个action及请求字段完全采用POINT-DELIVERY.md：point.getState、point.claim、point.correct、point.post；写命令带requestId，返回既有CommandReceipt，成功后重读状态。开始和再来一次复用activity.prepare。

shared已导出PointSnapshot、PointParticipant、PointCardDTO、PointChange、PointResult；foundationRequestSchema已包含四个action。DTO与提案一致，时间createdAt/savedAt使用epoch毫秒；cards初始revision为0。

分页补充：point.getState payload支持可选resultCursor和changeCursor。响应顶层nextResultCursor、nextChangeCursor，均string|null。results、activity.changes分别每页最多20条，最新在前；下一游标表示下一页首记录，原样传回。只翻某一种分页时，另一种仍返回首屏，不要重复追加另一种。totals每次均为服务端完整累计，不能由results当前页重算。翻页过程中有新结果/新修改时，已发出的游标仍沿原有不可变记录链继续；切换活动后旧changeCursor返回STALE_CONTEXT。跨房间结果游标返回INVALID_ARGUMENT。

point.getState在选中point_ball且无活动时返回activity:null，totals初始{}（界面参与者累计缺省可显示0）；其他玩法返回STALE_CONTEXT，非成员FORBIDDEN。当前活动result是当前活动已保存结果或null，不随历史分页改变。

claim仅本场参与者可用；correct仅处理已经归属的牌，有效房间成员均可操作，目标null或本场参与者。转回公共区后再claim仍保留initialRecordedBy。同目标correct返回CONFLICT（不产生空修改日志）。牌写使用expectedCardRevision，全局activityRevision只在post验证；每次有效改牌都递增活动revision。不同牌请求不校验全局版本，但真实云事务冲突仍可能重试或失败。

post仅本场参与者可用，15张完整后按earnedPoints−120/本场参与人数计算（两人60、三人40），以活动唯一结果和事务保证只累计一次。同requestId重试返回原Receipt；不同ID重复保存ALREADY_POSTED；已进入新活动的旧写入返回STALE_CONTEXT，已成功旧命令原ID重试仍仅返回旧Receipt。前端应按返回activityId处理旧回执，不能将其解释为新活动的成功。

## 存储与验证进度

新增集合point_changes、point_results、point_totals。均应ADMINONLY，仅通过api访问。历史按不可变记录链分页，累计单独按房间存储；不增加查询索引。活动原有15牌文档添加initialRecordedBy，activity添加可选latestPointChangeId，已有未开始/未认领活动兼容。

云端集合和函数已更新。新增3个集合已加入manifest并创建为ADMINONLY。未修改miniapp。

本地测试覆盖认领/修正/退回、初始记录人保留、同牌竞争与不同牌请求、原ID恢复和异载荷拒绝、晚加入权限、完整120分结算、只累计一次、保存后只读、再来一次保留历史、旧请求隔离、活动版本冲突、写失败原子回滚及分页。MemoryStore串行事务不能证明真实云端并发争用、锁和配额行为。

验证结果：后端26项测试全部通过（含21局分页与累计测试），全仓类型检查通过；build:cloud和check:cloud-package通过。此前前后端并行开发阶段的类型错误已解决。

## 新环境与入口修复（2026-10-21）

当前环境已改为scoreboard-d7giv4iri8369fe43（AppID不变），15集合及2索引初始化完成，api/health已部署。真实小程序调用曾因平台附带tcbContext触发严格校验；现公共handler忽略userInfo/tcbContext元数据，业务未知字段仍严格拒绝，身份仍来自getWXContext。回归先失败再通过，后端27项测试通过。临时校验诊断已移除。

真实微信身份及单用户房间创建、原ID重试、快照与最近列表已验证通过。保留联调房间码100332（point_ball，1人、未开始），待其他真实微信成员加入后做三人打分验收。没有伪造参与者或模拟多人数据写入线上。

## 2026-10-22：支持两人或三人

- activity.prepare接受2或3名唯一、有效房间成员，仍须包含操作者；其他人数拒绝。固定本场名单，晚加入者不改变参与人数/底分。config.baselineUnits=120/participantIds.length，两人60、三人40。
- point.getState/claim/correct/post及所有请求、响应DTO不变，shared无需修改。point.post按固定名单计算earnedPoints−120/N，不使用房间成员数；仍需完整15张、总分120，幂等和原子累计规则保持。
- 新建打分活动rulesVersion=point-ball-v2；其他玩法规则版本不变。旧三人活动foundation-v1、baselineUnits=40继续可读/操作/保存，无需改写；已保存历史和累计不重算。读取历史逐条按该记录自己的participants校验人数、分数和净分，混合两人/三人历史可共存。
- 不新增集合/索引，不需数据迁移；需要重新部署api，health代码没有变化，无需重传。
- 后端29项测试通过，全仓类型检查及后端构建/部署包检查通过；覆盖两人55/65→−5/+5、晚加入权限、两人转三人历史累计、旧版三人活动兼容、错误人数/底分/历史净分拒绝、原ID重试。api已部署至scoreboard-d7giv4iri8369fe43，状态Active/Event/Nodejs20.19/index.main；云端源码确认包含point-ball-v2及动态底分。管理端调用正常进入微信身份校验（InvokeResult=0、UNAUTHENTICATED），请求c6c869f6-9de4-44c3-9d1b-dbb24a930e4b。health未重传；无需新增集合或迁移。新规则的真实两账号完整结算仍待验收。
