# 首次资料完善：后端交接

## 2026-10-22 最新规则：自动默认资料

本节覆盖下文首次强制选头像/填写昵称的旧规则。用户已确认自动分配，前端取消首次拦截，仍保留编辑入口。

- `Me.defaultAvatar?: {template:'person-v1';color:string}`已加入shared，color为`#RRGGBB`。`IdentityDTO.profileCompleted`仍必填，自动生成后为true。展示优先级：avatarFileId优先，否则defaultAvatar。默认头像由前端本地SVG绘制，不上传SVG、不返回SVG markup/URL。
- shared已导出`createDefaultProfile(random?:()=>number)`纯函数、`DEFAULT_PROFILE_ADJECTIVES`、`DEFAULT_PROFILE_ANIMALS`和`isDefaultAvatar(unknown)`；Mock可注入random，SVG仅接受isDefaultAvatar验证过的模板/颜色。生产后端使用Node crypto随机源，前端不要在render调用生成器。颜色拒绝采样有32次上限，极端固定随机源回退#72B9A6，避免死循环。
- 新用户识别时后端从固定中性词库随机生成“形容词＋的＋动物”和RGB颜色，颜色各通道64—224、加权亮度110—200；只保存一次，事务重试不重复换值，并发首次请求返回同一持久化资料。昵称允许重名，不替代内部userId。
- 老用户在本人下次身份识别时逐步补齐：保留自选昵称与云头像；仅旧占位“微信用户”（无显式完成时间）或空昵称生成新名。缺失默认头像会生成持久化备用色，已有自选云头像仍优先。默认字段损坏时修复，不重写旧活动姓名/头像快照。
- updateProfile允许只提供昵称，保留现有云头像/默认头像。avatarFileId=null表示回到同一默认头像，profileCompleted仍为true；上传新云头像沿用原校验。客户端不能写defaultAvatar、profileCompleted、完成时间等服务端字段，schema严格拒绝。
- 请求action/Receipt不变，默认头像字段可选以兼容历史数据。无需新增集合/索引，不需批量迁移；api需要更新部署。后端35项测试、cloud/shared类型检查、构建及部署包检查通过；api已部署并通过真实微信复验，见下方最新记录。

2026-10-22。前端任务负责miniapp，后端任务负责cloud/shared。本文件优先于对话中的早期设想。

## 确定接口

- `identity.getMe {}`：IdentityDTO新增必填`profileCompleted:boolean`；`Me`新增可选同名字段以兼容房间成员/历史摘要。其余字段仍为userId、displayName、avatarFileId（string|null）。
- `identity.updateProfile`沿用原action和CommandReceipt，payload为`{displayName,avatarFileId?}`，命令带requestId。昵称trim后1—32字符，空值拒绝。头像可省略（保留原头像）或null（清除头像、资料完成状态恢复false）；首次资料流程必须同时有昵称和头像，前端不显示默认名已完成。
- 保存成功后重读getMe，以服务端profileCompleted为准；未知结果保留原requestId及完整payload，原ID确认，不重新上传或换ID写入。
- 新用户profileCompleted=false；显式保存昵称且有头像时置完成时间。历史用户若无该字段，有非默认昵称和头像则兼容视为已完成，无需迁移。

## 头像上传

- 原生`button openType=chooseAvatar`取得临时路径，支持手动昵称和`input type=nickname`，不用getUserProfile或自动读取微信个人资料。
- 先用wx.cloud.uploadFile上传，再把fileID交给updateProfile。云路径严格为`avatars/{内部userId}/{唯一ID}.{ext}`；唯一ID8—100位ASCII字母、数字、下划线或连字符，扩展名小写jpg/jpeg/png/webp，单文件不超过2MB。不要使用含openid的路径。
- 后端验证fileID为当前环境、本人userId命名空间、限定扩展名，再下载核对文件可读、大小及图片头（JPG/PNG/WebP）。不接受本地临时路径、外链、其他用户或其他环境fileID。图片头校验不是完整图像解码或内容审核。
- 上传阶段失败不发送资料保存，保留昵称并允许重新选择。不要把头像临时路径/临时下载URL存入用户资料。头像可直接使用cloud fileID展示；如果转临时URL，只作为短期展示缓存。
- 不自动删除旧头像，避免损坏活动头像快照或结果未知的请求；未使用文件的清理不在本轮实现。
- 资料更新不会重写已开始活动的参与者姓名/头像快照；新房间成员列表重读时显示最新资料。

## 流程与权限

首次profileCompleted=false先完善资料，保存成功继续原创建/加入/分享路径，保留房间码等参数。取消不误标完成。已完成用户有再次编辑入口。页面按用户和环境隔离草稿/未知请求，提交前保存恢复日志。

资料完成标记用于前端引导，不改变现有房间鉴权或强迫未完善资料的用户获得其他人的资料。身份仍从可信getWXContext读取，不信任请求userInfo/tcbContext或用户自行传来的ID。

云存储已配置：头像目录仅非匿名登录用户可读、创建者可写，并限制图片路径和大小；其他路径继续拒绝客户端访问。资料保存每用户每分钟最多10个不同请求，成功命令原ID重试不重复计数；事务内部重试复用同一次头像验证结果。

## 后端验证与部署状态

- 33项后端测试通过：新旧用户完成状态、昵称trim/长度、路径/环境/用户隔离、文件大小/图片头、失败不写资料、收据失败回滚、原ID恢复不重复校验、异载荷拒绝；原有活动快照测试继续通过。
- api已部署至scoreboard-d7giv4iri8369fe43；健康函数没有业务变更。构建和部署包检查通过，无新增集合、无需迁移。
- 已通过真实微信独立云实例读取profileCompleted=false，并上传/读取临时PNG成功，随后执行deleteFile清理；未设置用户昵称或头像。
- 当前模拟器默认wx.cloud实例调用api与health均出现-404006 empty poll result。独立new wx.cloud.Cloud({resourceEnv:env})实例await init后调用health成功（请求5d71f72c-b6ca-46f7-b750-f6201674c838），同实例uploadFile/getTempFileURL也通过。前端请据此核对原生receiver与实例生命周期，不以放宽后端schema解决。
- 前端初次沟通已发送并获实现回应；第二条进度消息被用户拒绝发送，没有重试，故以共享文件传递最终状态。
- 微信chooseAvatar交互及实际用户保存资料的完整UI链路由前端走查；没有替用户选取正式头像/昵称。

最终核对：全仓类型检查通过，前端48项测试与微信Function兼容性回归通过，后端33项测试通过。云端api Active/Event，代码包含profileCompletedAt、头像内容校验及profile_update限流。头像目录回读为空，确认测试图片已清理。前端页面和Mock源码已接入；前端任务后续将选择头像和昵称集成为一个按钮。完整新页面的微信构建/选择头像/保存流程尚未在本轮验收（前端任务记录构建请求被拒绝，未代为绕过构建）。

自动默认资料验证：新增/更新测试覆盖首次默认完成状态、固定默认昵称/颜色、并发首次读取单记录、颜色亮度范围、只改昵称、上传头像后清除恢复原默认色、保留旧自选资料、旧占位资料补齐、未知默认字段拒绝和共享纯生成器固定随机源无死循环。35项后端测试通过。前端正在并行接入；未改apps/miniapp。

## 自动默认资料：部署完成

2026-10-22，api已更新至scoreboard-d7giv4iri8369fe43。真实微信独立Cloud实例两次getMe均成功，自动补齐昵称“自在的狗”、defaultAvatar={template:person-v1,color:#45CB57}、profileCompleted=true，两次响应完全一致。请求cdd7afe1-9950-4ba7-9a1b-8f04fb8bdfbc、e5e9ffc7-255a-4a3e-85e6-97873aa5a45e。没有上传默认图片或改写活动历史。

shared最终导出名：DefaultAvatar、createDefaultProfile、isDefaultAvatar、DEFAULT_PROFILE_ADJECTIVES、DEFAULT_PROFILE_ANIMALS。前端Mock与生产后端共用纯生成器；后端仅额外包装crypto随机源。后台35项测试通过。前端并行开发中的类型错误以其最终检查为准，本后端任务未修改miniapp。
