# FE HTTPS配置

结论（2026-10-28）：.env.http默认API地址为https://api.siteforsk.ink，ALLOW_INSECURE=false；原mock/cloud默认脚本未改，IP只保留显式调试入口。HTTP-MIGRATION.md已更新真实域名、request/downloadFile合法域名、停止旧watch后运行npm run dev:miniapp:http及本地覆盖优先级。

验证：100/100前端测试通过；HTTP传输/登录/维护/原ID恢复、微信Function/Cloud桥、HTTP/cloud/mock运行时分流通过。真实Taro SWC配置加载支持cloud/IP/HTTPS；生产拒绝HTTP。新增回归核对HTTPS默认值与insecure=false，真实域名运行时在无process全局VM下通过。eslint、typecheck、本次脚本Prettier通过。保留技术负责人已有process分支门闩及config目录内独立校验，未修改配置加载实现。

待办：未启动完整Taro提权构建、未发布/切正式数据、未验证实际服务器HTTPS/真机。用户先停止其他watch，运行npm run dev:miniapp:http并重编译；配置微信request和downloadFile合法域名https://api.siteforsk.ink，检查.env.http.local无旧IP覆盖，随后验证登录、头像、入房与记分。服务器证书/凭据/迁移状态由技术负责人单独确认。

## 体验版连接诊断（2026-10-29）

- 现象：/auth/wechat约49ms失败、0B；前端原先统一转换为连接失败，底层信息丢失。负责人公网curl独立复现TCP约3ms、约55ms后TLS握手失败，尚未确定手机链路的具体原因。
- platform/backend.ts增加[http-connection]日志，仅输出固定路径、固定错误分类和耗时，不记录code/token/请求正文/原始错误；保留原异常及未知写入保护。
- 实际runtime回归先失败（无日志）后通过，覆盖ERR_CONNECTION_RESET和敏感字段不泄露；真实Taro配置加载回归、typecheck及修改文件lint/format通过。未启动完整Taro构建、未上传。
- 下一步：HTTP模式重新编译后重现，读取[http-connection]分类区分TLS、连接重置、超时或域名校验；不可宣称连接问题已修复。

## 连接重置定位（2026-10-29）

- 用户日志/auth/wechat ERR_CONNECTION_RESET、52ms。公网域名HTTP明确返回阿里云ICP备案拦截；域名TLS失败而IP健康诊断200，服务器内部TLS正常。故障范围为域名公网接入，详见reports/network-access.md。
- 保持HTTPS域名及登录配置，不将IP/关闭证书校验作为修复。接入恢复后再验体验版登录。
