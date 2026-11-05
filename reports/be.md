# HTTPS部署模板交付

2026-10-28，已完成；仅修改apps/cloud/deploy及本报告。

- 正式基址统一为https://api.siteforsk.ink；默认NODE_ENV=production、HTTP_ALLOW_INSECURE=false、WRITE_ENABLED=false。
- nginx.conf提供命名域名80端口ACME webroot、308跳转及443 TLS1.2/1.3反代，真实证书路径指向/etc/letsencrypt/live/api.siteforsk.ink/。不伪造证书、不覆盖IP调试虚拟主机。
- README补首次无证书时的80端口引导配置、Certbot webroot签发、自动续期机制检查、成功续期后nginx -t/reload deploy hook、dry-run检查及HTTPS/维护态验收说明。后端鉴权/IP例外代码不变，未开启写入。
- 本地检查通过：正式环境默认值、域名/ACME/TLS/反代关键指令、括号及空白检查，续期hook通过sh -n。
- 本机无Nginx，未声称nginx -t通过；真实证书签发、服务器nginx -t/reload、定时续期与微信合法域名由技术负责人验证。本任务未操作服务器、读取secret、申请证书或部署。用户已确认备案完成，HTTPS实测状态以负责人部署报告为准。
