# 单机HTTP迁移契约

状态：实现中，2026-10-27。北京Ubuntu-amvy，2核2GB，Ubuntu24.04；Node.js + 本机MySQL。未验收前旧云端继续服务。

- GET /healthz：200 {ok:true}；/readyz检查数据库和必要凭据，不泄露配置。
- POST /auth/wechat：JSON {code:string}；服务端code2Session校验，成功 {ok:true,data:{accessToken:string,expiresAt:number}}，expiresAt毫秒时间戳。失败沿用 {ok:false,error:{code,message}}。相同AppID/openId使用原stableId算法。
- POST /api：Bearer accessToken，body原foundationRequestSchema，返回原defineHandler信封/DTO。拒绝客户端自报身份；会话失效返回401及UNAUTHENTICATED。
- FE登录单飞，401最多重登录重放一次，原requestId不变；未知写结果不换ID。HTTP失败绝不自动回写云端。
- API_BASE_URL发布配置，HTTP模式默认关闭，云模式保留；开发IP仅演练，正式使用合法HTTPS域名。停写返回503及MAINTENANCE，FE显示维护并保留待确认操作。
- 本轮保留热状态/历史原DTO兼容，服务端优化访问；历史分页协议后续另订。
- BE先补头像可部署契约，FE依此适配。不得伪造cloud fileId、丢弃历史头像或让HTTP记分依赖跨云函数。
- 成功回执必须事务提交，保留幂等/CAS/历史/积分单位/冻结名单；切换前完成数据与回退演练，禁止双写。

## 头像HTTP契约（BE实现，2026-10-27）

- `avatarFileId`继续是持久引用字符串，已有cloud://引用原样保留，不改历史快照。默认SVG头像继续使用defaultAvatar。
- `POST /avatars`：Bearer会话，原始图片二进制body（不是multipart/base64），Content-Type为image/png、image/jpeg或image/webp，最大2MiB；返回ApiResult<{avatarFileId:string}>。新引用形如`avatar:v1:usr_<64hex>:<32hex>.(png|jpg|webp)`，再传identity.updateProfile；只接受本人引用并验证图片。失败不保存资料。
- `POST /avatars/resolve`：Bearer会话，JSON `{fileIds:string[]}`，最多50个；返回ApiResult<{urls:Record<string,string>,unavailable:string[]}>。urls值为有效期1小时的HTTPS签名地址，可直接供Image显示；短期URL不保存为avatarFileId。未找到映射的旧引用进入unavailable，FE保留原引用并显示defaultAvatar/首字兜底，不清空资料。
- `GET /avatars/content/<64hex>?expires=<毫秒>&signature=<签名>`仅凭有效限时签名读图片，响应图片Content-Type、nosniff和私有缓存；签名过期重新resolve。签名密钥只在服务器环境配置。
- 旧云图片需管理端导出对象，导入旧fileId→本地对象映射；HTTP服务不调用云函数或CloudBase SDK，未导入的旧图片不可展示不等于已完成迁移，正式切换前必须核对全部引用映射。旧存储继续保留以便回退。
- HTTP维护期间/api、登录和上传均503 MAINTENANCE；resolve/已签名图片可继续读取。登出`POST /auth/logout`撤销当前Bearer会话；访问令牌为可撤销的随机opaque token，数据库只存SHA256，最长7天。


## HTTPS配置（2026-10-28）

- 用户确认siteforsk.ink备案已完成；目标统一https://api.siteforsk.ink，免费证书由服务器Nginx终止TLS。前后端基础URL一致，头像签名URL亦使用该域名。
- 服务器验证后关闭HTTP_ALLOW_INSECURE并使用production；WRITE_ENABLED=false保持，正式源仍为旧云端。客户端无自动故障回退，IP仅显式开发用途。
- 微信后台request、downloadFile合法域名配置为https://api.siteforsk.ink；以后若改用wx.uploadFile需再配置uploadFile。当前头像上传使用wx.request二进制。
