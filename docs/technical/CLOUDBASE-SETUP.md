# CloudBase 接入状态

日期：2026-10-21。按 [CloudBase Setup Skill](https://docs.cloudbase.net/skill.md) 及[微信小程序指南](https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/tutorials/ai-develop-miniprogram)执行。

## 已完成

| 项目 | 结果 |
| --- | --- |
| 账号站点 | 用户确认国内站；保持微信云开发wx.cloud接入体系 |
| Node/npm/npx | 已验证可用，Node 22.17.0 |
| Codex MCP | 已有启用的cloudbase本地配置，且cloudbase-mcp可执行文件存在；未重复安装 |
| 当前聊天工具 | 本聊天尚未加载CloudBase MCP，因此使用官方CLI完成本次连接 |
| CLI | 官方CloudBase CLI 3.8.7，经npx调用；项目检查命令固定该版本 |
| 登录 | 用户完成官方设备授权，CLI返回login succeeded；未开启可选使用数据收集 |
| 环境 | prod-d5g2mjphqdcb5bb94，名称prod，地域ap-shanghai，状态NORMAL |
| 环境选择 | CLI全局默认环境已设置；项目cloudbaserc.json也显式绑定，不依赖其他项目的默认值 |
| 微信AppID | 保留已有wx58f475b69b1fd4f6；不是touristappid |
| 构建 | 全工作区类型检查、后端构建、真实云模式的小程序构建通过 |
| 配置验证 | cloud:check从项目配置解析到同一环境；小程序产物已包含正确环境ID |

登录凭据由官方CLI保存在本机，未写入仓库。环境ID和AppID不是访问密钥。未新增API SecretId/SecretKey，也未手写重复的MCP JSON。

## 项目配置

- 根目录 `cloudbaserc.json`：真实环境ID、云函数构建目录、api/health部署模板。
- `apps/miniapp/.env.cloud`：显式选择真实云模式，不包含凭据。
- `apps/miniapp/config/index.ts`：云环境默认读取根配置，允许TARO_APP_CLOUD_ENV覆盖。
- 原有默认mock开发方式保留，真实模式使用独立命令，避免未部署业务时误认为本地演示已接入云端。

```sh
# 已验证的账号/环境连通性检查
npm run cloud:check

# 构建后端部署包
npm run build:cloud

# 小程序真实云模式开发/构建
npm run dev:miniapp:cloud
npm run build:miniapp:cloud

# 原有本地演示模式
npm run dev
```

配置中的函数运行时采用Nodejs20.19，构建语法目标node18保持兼容下限；api和health均已实际部署并调用验证。模板没有添加公开HTTP触发器。

## 尚未做、不能声称完成的事项

- 数据库集合、索引及客户端权限已于后续初始化，见末尾记录。
- api和health已部署，见末尾验证记录；未创建付费套餐或更改续费。
- 尚未验证小程序AppID与该环境的关联权限，不能仅凭CLI已登录声称wx.cloud端到端已成功。
- 当前聊天没有实际调用MCP工具；方便时重新加载Codex/聊天后再检查其工具是否可用。CLI路径现已可用，不需要等待重启才能继续后端工作。
- 尚未运行真实微信用户的身份、房间和活动准备联调。构建通过只证明工程配置可编译。

## 最相关的下一步

按 [基础接口联调说明](../../apps/cloud/FOUNDATION.md) 和 [数据库清单](../../apps/cloud/database/manifest.json)，创建12个集合与成员查询索引，客户端业务集合先保持拒绝直接读写；核对微信AppID的环境关联，并以两名微信用户验证创建/加入及活动准备。

部署使用领域命令 `tcb fn deploy`，不使用通用`tcb deploy`。当前唯一环境名为prod，执行后续资源写入前应按项目部署范围核对，避免将本地测试或演示数据当作业务初始化数据写入。

## api上传故障处理及部署验证（2026-10-21）

用户在CloudBase控制台上传api时遇到 `ResourceNotFound.Entryfile`，解压 `scf_bootstrap` 返回exit 11。使用当前实际构建目录生成诊断ZIP后可复现缺少该文件；但index.main导出有效，现有程序是事件函数入口。

该错误与HTTP/Web类型要求启动文件的行为一致，原控制台失败配置未能读取，不能声称已核实当时选择的类型。此次改为显式Event部署后，云端实际类型和调用结果均验证成功。

- cloudbaserc.json现在显式指定api/health的type为Event，避免上传时混淆类型；未添加HTTP服务或scf_bootstrap。
- 新增 `npm run check:cloud-package`，检查类型、handler、构建包根入口、main导出与SDK依赖。该检查必须先执行 `npm run build:cloud`。
- 仅通过CLI部署api，操作为create，环境prod-d5g2mjphqdcb5bb94；health未在本轮部署。
- 云端api状态Active，类型Event，运行时Nodejs20.19，入口index.main。
- 实际调用空对象返回预期业务校验错误INVALID_ARGUMENT；云平台InvokeResult=0、ErrMsg为空，证明入口及依赖可启动，不代表真实微信身份/数据库读写已验证。
- 调用请求ID：5ae3ed36-35ed-4947-9fb6-7de25d4cf2b3。

后续代码更新可按以下顺序操作，force仅覆盖指定api，不批量操作其他函数：

```sh
npm run build:cloud
npm run check:cloud-package
npx --yes --package @cloudbase/cli@3.8.7 tcb fn deploy api --force --yes --json
```

若使用控制台创建，选择事件函数（Event）并设置index.main，ZIP根目录直接包含index.js和package.json。控制台手工上传不会自动应用本地cloudbaserc.json；不要选择HTTP/Web后仅上传事件函数包。

参考：[官方函数配置](https://docs.cloudbase.net/en/cli-v1/functions/configs)、[Web函数启动文件说明](https://cloud.tencent.com/document/product/583/56126)。

## health部署验证（2026-10-21）

- 构建及部署包检查通过后，通过CLI单独创建health，环境prod-d5g2mjphqdcb5bb94。
- 实际调用确认类型Event，InvokeResult=0、ErrMsg为空，返回 `{"ok":true,"data":{"service":"scoreboard","status":"ok"}}`。
- 请求ID：65ddd604-8427-460e-9ff8-65709c36d8c1。
- 此探活仅验证函数运行，不验证微信身份或数据库访问。

## 业务联调前核对（2026-10-21）

- 本轮通过CloudBase MCP读取当前环境，状态NORMAL，NoSQL实例RUNNING。
- 实际列出集合为0（请求ID：c571c2fe-50c0-4679-866f-2c05168e97d9）。manifest列出的12个集合和2个成员查询复合索引尚待初始化；本轮未写入云端配置或业务数据。
- api函数权限读取结果为CUSTOM，规则要求 `auth != null && auth.loginType != 'ANONYMOUS'`。未开放匿名调用；真实微信调用是否通过仍待验证。
- 本地project.config.json的AppID为wx58f475b69b1fd4f6，前端目标环境取根配置，业务调用api。云端环境信息WxAppId为空，不能据此判定关联已建立或未建立；CloudBase应用列表为空也不能作为小程序关联状态的证明。需在控制台核对小程序关联或使用真实小程序调用验证。
- 后端19项本地测试通过；小程序云模式构建成功，当前dist已切换为cloud模式。沙箱内首次构建触发系统配置错误，停止该进程后在沙箱外重试通过。
- 前端RoomApi当前覆盖身份、房间创建/预览/加入/列表/快照，尚未接入activity.prepare。活动准备可先按FOUNDATION.md在微信开发者工具控制台联调。
- 尚未完成真实微信用户的身份、数据库读写、双用户加入与活动准备验收。先初始化缺失集合/索引并为各集合配置客户端拒绝读写，再进行真实用户验证。

## 数据库初始化完成（2026-10-21）

- 通过MCP在prod-d5g2mjphqdcb5bb94创建manifest列出的12个集合，每次创建后立即设为ADMINONLY（仅管理端读写，客户端拒绝直接读写）。未写入用户、房间或其他测试数据。
- room_members新增非唯一复合索引room_status_id：roomId升序、status升序、_id升序；user_status_recent_id：userId升序、status升序、lastVisitedAt降序、_id升序。
- 回读验证集合总数12、各集合文档数0；权限列表12项全部ADMINONLY；两条索引的字段顺序与方向匹配manifest。集合回读请求ID：8adc6cf7-8e9e-49c9-abd7-3ac4fc905593；权限回读：cd951bbb-637c-483f-945d-e1cb1b51c2e7；索引回读：a1580cfb-b38b-47f9-9b04-17ebbbc396e5。
- 下一项需要真实微信登录态：在微信开发者工具中重新编译云模式构建，执行下列调用。成功返回内部userId且再次调用保持相同，才可确认微信调用及身份数据库链路；管理端调用不能替代该验收。

```js
wx.cloud.init({ env: 'prod-d5g2mjphqdcb5bb94' })
wx.cloud.callFunction({
  name: 'api',
  data: { action: 'identity.getMe', payload: {} }
}).then(({ result }) => console.log(result))
```

后续双用户创建/加入和活动准备步骤参见apps/cloud/FOUNDATION.md。真实微信身份、业务事务及多人并发仍待验收。

## 三人打分部署及初始化修复（2026-10-21）

- 新增point_changes、point_results、point_totals并设置ADMINONLY，回读3项权限均匹配；总集合数15且全部文档数0，未写入测试身份或房间。
- 26项后端测试、全仓类型检查、云函数构建及部署包检查通过，已将包含point.getState/claim/correct/post的api部署至当前prod环境；云端Active、Event、Nodejs20.19、index.main。
- 首次合法schema探测暴露初始化依赖getWXContext().ENV的问题（请求37d74c12-bcbc-4577-a4ff-f64b931dd387返回INTERNAL_ERROR“云环境尚未配置”）。改为官方DYNAMIC_CURRENT_ENV初始化，并移除database选项中对该上下文字段的依赖。社区类型缺失通过集中窄接口适配，未改业务身份来源。
- 修复重新部署后，管理端调用point.getState返回UNAUTHENTICATED“请从微信小程序访问”，InvokeResult=0且ErrMsg为空；请求41efde00-6a39-4f01-8b71-2e25d6b80ddd。证明入口能启动、schema接受新action且身份拦截正常；没有微信调用身份，尚不能证明数据库业务链路通过。
- 下一步用真实微信账号从云模式小程序调用identity.getMe，再由三名成员验证打分活动准备、认领、修正和保存。

## 微信开发者工具联调检查（2026-10-21）

- 用户开启服务端口后，CLI确认login=true；Codex客户端自动化授权成功，skill版本0.3.11匹配，连接到本项目pages/index/index。
- 在小程序运行时默认wx.cloud调用identity.getMe，返回通用INTERNAL_ERROR，请求ID前缀local_debug；此次不能视为线上云函数调用验证。
- 使用独立wx.cloud.Cloud实例指定目标resourceEnv调用health，平台返回-601034“没有权限，请先开通云开发或者云托管”。仅记录实际现象，不据此将错误唯一归因于未关联。
- 从微信侧读取可用环境列表也失败，ret=1000 system error，wx_req_id=23c2292-1792585953，未取得可用环境清单。
- 待用户停止本地云函数调试，并在微信/腾讯云控制台核对小程序与目标环境关联后重新验证。未创建联调房间，真实微信身份数据库链路尚未通过。

## 新账号环境部署（2026-10-21）

当前目标已切换为scoreboard-d7giv4iri8369fe43；AppID仍为wx58f475b69b1fd4f6。旧环境保留，未迁移旧数据。cloudbaserc和小程序云模式构建均已更新。

- 已重新授权新账号，确认环境NORMAL、NoSQL可用。
- 创建15个业务集合，回读权限全部ADMINONLY；room_members两条复合索引字段和方向核对通过。
- api、health均已部署并确认Active/Event/Nodejs20.19/index.main。
- 管理端health调用成功：ok=true，service=scoreboard，status=ok；请求351c0882-025e-4fd8-8b1c-88b5aebe0cdf。
- 小程序调用已获得线上请求ID，但identity.getMe仍返回INVALID_ARGUMENT。忽略平台userInfo字段后仍未解决，不能声称身份与数据库业务链路通过。最近请求228b0709-4a3a-42c3-9be1-4811469a86b5、01df6bfc-52f1-4a79-9e53-c27320c5ddd6。需继续采集安全的schema失败原因定位，不能靠反复放宽校验猜测修复。
- 后端27项测试和部署包检查通过；本轮未创建联调房间。

## INVALID_ARGUMENT 根因定位（2026-10-21）

用户日志请求418f88f3-19a5-43a2-aca2-59e323297cc6显示参数校验拒绝。管理端合法identity.getMe返回UNAUTHENTICATED，说明业务schema本身接受该请求。临时诊断仅返回Zod错误类型和字段路径/名称，未返回任何event值；小程序线上请求c877f9e5-9fd2-4de4-9c52-23ed1977c374明确返回unrecognized_keys，顶层未知字段为tcbContext。

修复仅在公共handler入口忽略平台注入的userInfo/tcbContext，业务未知字段仍严格拒绝；不将这些字段用于身份，仍从getWXContext读取可信身份。已移除临时诊断。回归测试先复现失败（26通过、1失败），修复后27项全部通过；部署包检查通过。云端复验结果随后补充。

### 修复后的真实微信复验

api和health均重新部署，临时diagnostic已移除。小程序identity.getMe两次成功且内部userId稳定；线上请求00fc8593-0e5d-421c-a61f-6d6d8834594f、39e62b2d-8bb1-47ea-9090-d521dafb6ff3。

同一微信用户创建一个point_ball联调房间，业务requestId=integration_room_20261021_tcb_context；roomId=room_4ef1da46-178e-408a-8106-b416817278de，房间码100332。原ID重试返回同一收据、未重复创建；room.getSnapshot及room.listRecent均成功，当前1名成员且无活动。创建请求00526759-7308-4541-b402-3f0216baa75e，重试8a290035-574d-46b0-b4ae-ae26310f70bf，快照786bb33c-24f4-4611-8b83-d83737ec45b0。保留该联调房间供后续真实成员加入；未伪造其他微信身份，三人活动准备及完整打分保存仍未进行真实多人验收。

## 两人/三人打分规则更新（2026-10-22）

api已部署至scoreboard-d7giv4iri8369fe43，Active/Event/Nodejs20.19/index.main；云端代码确认point-ball-v2及120/本场人数底分。activity.prepare支持2或3人，新活动分别冻结60或40分；post依固定名单结算，历史逐条校验自身参与人数，旧三人活动及已存结果不重写。shared接口、集合、索引均无需变化，health未重传。

后端29项测试、全仓类型检查、构建及部署包检查通过。管理端identity.getMe探测InvokeResult=0、ErrMsg为空、返回预期UNAUTHENTICATED；请求c6c869f6-9de4-44c3-9d1b-dbb24a930e4b。此探测只证明启动及身份拦截，新规则真实两账号准备/认领/保存与并发仍待验收；没有伪造微信用户或改写线上历史。

## 首次昵称与头像流程（2026-10-22）

- shared IdentityDTO新增profileCompleted，用户记录新增可选profileCompletedAt，旧用户通过现有昵称/头像兼容判定，无需迁移。updateProfile保持原Receipt，保存只改本人资料，不重写活动快照。
- 头像限制当前环境本人avatars/{userId}/8—100位唯一ID.jpg|jpeg|png|webp，<=2MB；后端下载验证存在/大小/图片头。资料保存限流10个不同请求/分钟，原ID幂等重试和事务回滚已测试。
- 云存储由PRIVATE改为CUSTOM：仅非匿名用户读取avatars图片路径；创建者可写该路径且resource.size<=2097152；其他路径客户端默认拒绝。修改请求131e83d7-a32a-446d-a16c-45105ca7d8e3。业务数据库集合仍ADMINONLY。
- api已部署Active/Event，云端代码确认包含完成标记、头像校验和限流。33后端测试、48前端测试与兼容性回归、全仓类型检查和后端部署包检查通过。
- 真实微信独立Cloud实例identity.getMe返回profileCompleted=false；临时PNG上传、读取成功，删除后管理端查询avatars目录totalCount=0。未更改实际用户正式昵称或头像。
- 默认wx.cloud实例在当前模拟器出现-404006 empty poll result；独立Cloud实例health成功（请求5d71f72c-b6ca-46f7-b750-f6201674c838）。客户端实例问题和新页面完整微信选择/保存流程仍需后续联调。前端任务记录构建请求被拒绝，本轮未绕过执行小程序构建。完整契约与边界见PROFILE-BACKEND-HANDOFF.md。

## 默认昵称与SVG头像元数据（2026-10-22）

用户确认取消首次强制填写，改为后端首次身份识别时自动分配默认资料。api已部署：词库昵称＋person-v1模板/#RRGGBB颜色持久化，旧未完成资料本人下次访问时补齐，已有自选资料保留，历史活动不改写。默认资料profileCompleted=true，仅改昵称可省略avatarFileId；清除自选头像后恢复原默认色。客户端不能写默认字段。无新集合/迁移、无默认图片上传、health无变更。

35项后端测试、cloud/shared类型检查、构建及部署包检查通过。真实微信getMe连续两次返回相同“自在的狗”/颜色#45CB57，完成状态true；请求cdd7afe1-9950-4ba7-9a1b-8f04fb8bdfbc、e5e9ffc7-255a-4a3e-85e6-97873aa5a45e。前端本地SVG绘制和取消首次拦截由前端任务接入，最终UI验收另行记录。

## 最近房间后端（2026-10-22）

api已更新：room.enter、room.dismissRecent、room.listRecentPage及旧listRecent补位兼容；getSnapshot不再写成员最近时间。仅新增可选room_members.recentHidden，复用现有user_status_recent_id索引，无新集合/迁移/权限变更。42项后端测试、全仓类型检查、后端构建和包检查通过；云端Active/Event，源码确认新action与扫描预算。管理端新分页入口InvokeResult=0、预期UNAUTHENTICATED，请求b134dd21-e312-4885-a3fb-8cdf5f15ae45。

微信自动化探针失败于Remote debug connection lost，未拿到业务返回；两次管理端查询该探针创建收据为空。已交由前端单独控制模拟器恢复验证，不能将此阶段写成真实微信/多账号验收通过。完整契约及边界见RECENT-ROOMS-BACKEND.md。
