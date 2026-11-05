# 最近房间前端交付

日期：2026-10-22。任务依据：RECENT-ROOMS-TASK.md、PRD HR01—HR06、home-recent-handoff/SPEC.md。仅修改miniapp与本交付/截图；shared及cloud由后端维护。

## 功能与接口

- 首页最多3条、同房去重；保留“全部”，展示已加载的全部条目，并支持加载更多。
- 使用room.listRecentPage，经RoomApi.listRecentPage(cursor,20)读取。nextCursor原样回传；空扫描页不代表结束，首页继续读到至少3条或null，加载更多继续到新增20条或null。重复游标报错，不死循环。
- room.dismissRecent/room.enter写入均附requestId，适配器验证返回requestId及roomId一致；异常回执按未知结果处理。
- 卡片前景保持完整宽度，横移80px显露删除槽，不压缩文字。超过8px后按横/纵1.5倍识别方向，超过半槽宽展开；一次仅一个房间展开。纵向保持滚动，滑动及收起点击不会导航。删除中卡片保留、操作禁用；成功后重新查询补位，失败保留并可恢复。
- 成功移除提示“已从最近房间移除”；空态“暂无最近房间”。创建、房间码加入入口保留。
- Mock持久化hiddenRecent与enteredAt，create/join/新enter恢复可见性并更新进入顺序；getRoomSnapshot只读。旧无隐藏字段默认可见；旧排序数据兼容。房间、成员、分数与历史不删除。

## 恢复、并发及身份边界

- Recent Zustand控制器独立维护pending/failed/unknown状态和原操作；同一时间只有一个写操作。未知操作不能被其他房间/其他kind覆盖。
- 写前持久化原kind、roomId、requestId、userId及待移除卡片预览；key按Mock/云环境及userId隔离。刷新或重新启动后，未知移除仍保留原卡片，不重复生成ID。
- 已提交但响应丢失时，仅“确认原操作”重试同一请求。确认后再查询列表；普通刷新不能绕过未知状态而提前显示删除成功。已成功的旧enter/join回执不会被当作新的主动进入。
- 列表请求和写操作有generation/owner护栏，旧列表不复活已移除条目；跨身份迟到成功/失败均不能覆盖新身份页面。损坏journal每次重读仍报错，不因owner已缓存而放行新写。
- 第一次主动导航/直达房间时显式enterRoom；enterRoomOnce的marker位于页面wrapper中、ProfileGate外。后台onShow、同页快照刷新、资料编辑后内容重挂载均不重复enter。新导航产生新marker。
- 如果旧unknown阻挡本次直达enter，先确认原操作，再明确显示“更新进入记录”重试本次新enter；不覆盖旧请求，不静默忽略此次进入。
- 迟到回执不负责导航；room快照继续沿用既有页面generation校验。跨身份旧journal留在原用户key中等待本人恢复。

## 初始化修正

微信实际走查发现：ProfileGate异步识别身份后才挂载页面内容，可能错过Taro首次onShow，造成首页按钮一直禁用且最近列表不加载。首页/加入页/扑克创建页补上首次useEffect只读恢复；房间页首次useEffect读取快照。onShow仍保留只读刷新，主动enter仅由独立visit marker触发。该修正没有增加玩法或计分写入。

## 验证

- `npm test --workspace @scoreboard/miniapp`：61项通过，另动态Function兼容、独立原生Cloud初始化/receiver/失败恢复检查通过。
- 新用例覆盖：超过20条Mock隐藏仍补位、隐藏重启持久、快照不恢复/不重排、旧enter回执不能复活新隐藏、新join恢复且不重复成员、空扫描页/去重、pending卡片保留、unknown原ID恢复与预览重启、损坏journal阻止新写、跨身份迟到成功/失败/列表拒绝、已确认移除后的迟到列表、手势方向和阈值、一次页面visit、known失败重试、新接口cloud映射。
- `npm run typecheck --workspace @scoreboard/miniapp`通过；最终`npm run build:cloud --workspace @scoreboard/miniapp`通过，输出保持cloud模式。
- DOM真实页面：6条本人已有Mock房间首页只显3条，“全部”显6条；横滑不导航，删除628388后628393补位；模拟请求失败保留628390；模拟成功丢响应，重开保留原卡片并用原请求确认成功。
- 微信开发者工具+真实云端：冷启动显示现有房间100332；手势左滑露出删除，点击出现“移除中…”后空态；重新编译打开后仍空态；通过100332房间码预览、加入成功，房间仍1名成员、无活动，返回首页同一房间恢复且无重复。本次未创建测试房间，未改牌、成绩或历史；最后已恢复本人最近条目。
- 本轮仅前端控制模拟器。后端先前probe连接失败不作通过证据，本节记录的是后续实际UI验证。

## 截图

截图位于screenshots/recent-rooms/：

- default.png / swipe.png：默认三条与横滑展开。
- pending.png / failure.png / unknown.png：卡片保留、防重复、失败与原请求恢复。
- refill.png：成功后下一条补位。
- wechat-swipe.png / wechat-empty.png / wechat-restored.png：真实云端移除和主动重入恢复。

## 未验收范围

实体手机触摸与系统返回手感、不同机型纵向滚动阈值、真实多账号隔离仍未验收；相关身份/并发语义由本地测试覆盖，不等同真人多账号结论。大量隐藏扫描由后端测试覆盖，真实云端UI本轮只有1条房间，不伪称线上超过20条验证。业务分数与其他玩法未扩展。
