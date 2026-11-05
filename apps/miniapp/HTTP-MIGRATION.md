# HTTP接入与验证

HTTP模式需要显式启用，现有cloud与mock入口保留。不自动故障切换、不双写；各后端的待确认日志按环境/HTTP服务地址与用户隔离，切换前必须先确认旧后端在途操作。

HTTP模式默认服务地址为 `https://api.siteforsk.ink`（apps/miniapp/.env.http），ALLOW_INSECURE=false。仅隔离测试需要在 .env.http.local 覆盖地址；旧本地覆盖可能优先于新默认值，启动前自行检查该文件。不要写入服务端密钥。

从仓库根运行HTTPS开发入口：

```sh
npm run dev:miniapp:http
```

先停止旧cloud/mock/IP watch，避免多个进程写入同一dist；重新启动后在微信开发者工具重新编译，确认请求发往该HTTPS域名。不要沿用旧cloud进程来验证新接口。

正式构建入口（本轮未执行）：

```sh
npm run build:miniapp:http
```

在微信公众平台「开发管理 → 开发设置 → 服务器域名」中配置：

- request合法域名：`https://api.siteforsk.ink`，用于登录、API、二进制头像上传和头像地址解析；上传走request原始二进制，不是uploadFile。
- downloadFile合法域名：`https://api.siteforsk.ink`，用于头像图片下载；若签名图片改由其他HTTPS域名提供，也需加入实际域名。

以真实设备验证图片加载、证书链和HTTPS访问，不依赖关闭域名校验。客户端地址更新不代表服务端证书、微信凭据、数据迁移或业务切换已验收。

云模式仍保留原入口，供明确需要的旧环境使用，不与HTTP同时watch：

```sh
npm run dev:cloud --workspace @scoreboard/miniapp
npm run build:cloud --workspace @scoreboard/miniapp
```

HTTP传输使用POST /auth/wechat、POST /api和Bearer内存会话。登录单飞，过期恢复，401最多重登录重放一次，使用同一DTO/requestId；网络超时不自动重放。503明确提示维护，并保留原待确认日志。客户端不保存AppSecret/openId/session_key，不记录请求载荷或令牌。

头像使用POST /avatars原始二进制图片；得到持久avatar:v1引用后再保存资料。POST /avatars/resolve取得短期HTTPS地址，仅内存缓存55分钟，图片失败时再解析一次；原cloud://引用照样解析，未映射时显示默认头像，不清空资料/历史。默认SVG不上传，签名URL不作为avatarFileId保存。HTTP上传不会调用云存储。

切换前验证：资料/头像、分享加入、最近房间、认领/更正/结算、大A记分；多账号并发、401恢复、维护、超时后同ID恢复；旧头像映射齐全；正式HTTP构建、bundle检查与真机Wi-Fi/移动网络耗时。未经这些验证不切换流量、不发布小程序。

## 指定IP演练入口

```sh
npm run dev:http:ip --workspace @scoreboard/miniapp
```

独立http-ip模式固定 http://101.201.236.27，仅development且--watch允许该地址。正式非watch HTTP构建在加载配置时拒绝非HTTPS地址，即使ALLOW_INSECURE=true也不会放行；运行时也有独立保护。无需修改默认cloud模式或根配置。

开发者工具需要开发用域名校验条件；真机HTTP演练需平台允许的开发/调试模式及网络可达性，不能据此承诺体验版/正式版可用。默认联调应使用已配置的HTTPS入口；IP仅保留为显式开发调试。服务端凭据、迁移与真机验证状态以技术负责人的最新报告为准。
