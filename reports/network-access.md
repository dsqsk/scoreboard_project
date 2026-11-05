# 域名公网连接重置

2026-10-29，体验版/auth/wechat报ERR_CONNECTION_RESET，约52ms、0B。

- 同一负责人公网网络：域名HTTPS握手约52ms失败（TLS1.2亦失败）；IP直连仅诊断健康接口200、约97ms。IP诊断跳过域名证书匹配，不作为上线地址。
- 域名HTTP返回403，Server: Beaver，页面标题Non-compliance ICP Filing，指向阿里云beian-block。
- 服务器内域名HTTPS/回环HTTPS均200；nginx -t通过，nginx及scoreboard正常，Nginx错误日志检查无异常。
- 结论：故障定位至域名公网接入链路；结合明确备案拦截页，高度怀疑阿里云备案/接入校验导致域名TLS被重置，需供应商确认。浏览器某次200不代表所有网络均解除。
- 处理：在阿里云ICP备案控制台核对siteforsk.ink的管局审核成功及接入状态；已成功则提交工单核对api.siteforsk.ink到101.201.236.27的拦截及状态同步。不得通过换IP、取消HTTPS、关闭证书校验绕开正式接入要求。
- 验收：同一网络HTTP能到达Nginx并308跳转；HTTPS完整证书验证200；体验版/auth/wechat不再连接重置并能真实登录。

工单内容：域名api.siteforsk.ink解析至北京轻量服务器101.201.236.27。源站Nginx及内部HTTPS正常，但公网HTTP返回Beaver 403 Non-compliance ICP Filing；公网携带域名的TLS约52ms重置，IP诊断可达。用户表示备案已完成，请核对主域siteforsk.ink的ICP备案接入、域名拦截记录及同步状态，并协助解除异常拦截。

## 放行复测（2026-11-04）

- 用户确认备案完成。负责人公网curl未跳过证书校验：HTTPS /healthz与/readyz均200；HTTP /healthz返回Nginx 308至相同HTTPS地址。
- 本轮未出现此前Beaver 403或TLS重置，原网络路径的备案接入阻塞已解除。尚待用户体验版真实登录复验，不代表记分200ms目标已验收。
- 无服务器或业务数据变更，无需重复迁移、重新部署证书或切回旧云端。
