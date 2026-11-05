# HTTP/MySQL 本地交付与部署模板

构建：仓库根 `npm run build:http --workspace @scoreboard/cloud`。产物为 `apps/cloud/dist/http/`，启动 `node server.cjs`，迁移 `node migrate.cjs <command> ...`。运行环境Node22、MySQL8；在产物目录安装其package.json依赖，HTTP包不含wx-server-sdk，不运行旧Event入口。无需改小程序DTO。

配置键详见scoreboard.env.example。必填：DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD、WECHAT_APP_ID/WECHAT_APP_SECRET、PUBLIC_BASE_URL（合法HTTPS域名）、AVATAR_SIGNING_KEY（至少32字符随机密钥）。HOST/PORT默认127.0.0.1:3000，AVATAR_DIRECTORY默认/var/lib/scoreboard/avatars，WRITE_ENABLED默认false，MAINTENANCE_FILE默认/var/lib/scoreboard/MAINTENANCE。环境文件0600，不提交真实凭据。

GET /healthz仅进程健康；/readyz检查必要凭据、数据库连接及激活迁移标记。未初始化或凭据缺失503。POST /api仅Bearer；POST /auth/wechat交换真实wx.login code；不启用测试身份。会话最长7天，可POST /auth/logout撤销。数据库存token哈希，微信session_key不持久化或返回。登录按连接来源每分钟20次限流；当前反向代理同源会共享此预算，正式部署需根据可信单层代理配置决定IP传递方式，不信任公网自报X-Forwarded-For。

WRITE_ENABLED=false或维护标记文件存在时阻止登录/API/上传，503 MAINTENANCE；包括可能更新身份/最近访问的读入口，不只拦记分。用文件开关避免维护时改服务配置。未验收前保持关闭。旧云端停写、排空、最终导出后再导入；禁止新旧双写，不自动回退。

MySQL按17集合分表保存无损canonical JSON，使用生成关系字段与唯一/分页索引；不是单张通用文档表。sb_activity_hot存活动、15牌和分数热聚合，牌读取一次查询；批量canonical写按表合并，同事务更新热聚合。HTTP一次请求共享一条事务及缓存，身份/鉴权/业务/回执一并提交，失败整体回滚。FOR UPDATE与唯一约束保持CAS/去重，死锁/锁等待最多重试两次，不对未知commit结果自动重试。保留原历史previousId协议，仍有本地SQL逐条历史读取，后续单独改分页协议；未承诺200ms目标。

应用连接池5个连接、队列50、Node堆256MiB/systemd上限512MiB；MySQL建议由运维配置约256MiB buffer pool及有限连接数，避免2GB主机OOM，必须实测后调整。数据库/应用仅本机监听，公网由HTTPS反代。2026-10-28用户确认备案完成；正式接口域名为https://api.siteforsk.ink，证书与微信合法域名仍需部署负责人实际核验。

备份须含MySQL全库、avatars目录和密钥配置，异机加密保存，恢复演练在独立库。不要把迁移原数据或头像映射提交仓库。旧fileId保持原值，离线对象映射复制成功后才可验收头像迁移。不可访问旧对象时阻断切换，不删除旧云存储。

## 迁移工具（人工执行，不会随服务启动自动DDL/导入）

使用DDL迁移账户环境运行：`node migrate.cjs schema` → `node migrate.cjs validate archive.json` → `node migrate.cjs stage archive.json` → `node migrate.cjs activate archive.json` → `node migrate.cjs verify archive.json`。只允许名字包含rehearsal/staging/test的隔离库；正式库每步必须显式`--final`，stage/activate要求consistentSnapshot=true且WRITE_ENABLED不为true。必须先停止并排空所有写入，文件标记不能替代操作证据。

导入先在sb_staging完整保存，再在事务内批量启用并生成热状态，核对canonical摘要后激活；已有不同活动批次或新写入时拒绝覆盖。同文件重复stage/activate/verify不会生成重复记录，重复activate校验库仍与原摘要一致。保留全部17集合，rate_limits保持原窗口；outbox/signal作为档案保留，当前没有通知worker，不盲目重放旧通知。导出不会包含HTTP会话（回旧端后需重新登录）。

`node migrate.cjs export new-snapshot.json`以MySQL一致性事务导出同17集合格式，文件wx创建且0600、不覆盖既有文件，可供反向导入旧云数据库；工具不连接旧云端，也不自动合并旧库。新库已有真实写入后的无损回退，仍需技术负责人在两端停写后用该全量导出完成旧端受控替换/核验演练，未完成前禁止切回旧快照。

`node migrate.cjs avatars manifest.json`离线复制旧对象映射，manifest形如[{"fileId":"cloud://...","path":"objects/photo.png"}]，不访问任意远程URL、不改原fileId。现有对象内容冲突则拒绝。文件不进仓库。当前演练导出不含旧云图片引用，由负责人核查实际导出范围后确认。

真实MySQL烟测：在隔离库和WRITE_ENABLED=false下，设置MYSQL_SMOKE_ALLOW=true后运行`node smoke.cjs`。只创建随机smoke AppID下测试身份和房间，不经生产微信登录；验证建房/加入/准备、认领、幂等、同牌竞争、回滚、结算，核对导入记录未变化并清理本工具触碰的新ID。该工具不可用于生产库；运行期间保持其他写入停止。业务HTTP入口没有测试身份路径。

IP演练仅在NODE_ENV不为production且HTTP_ALLOW_INSECURE=true时允许PUBLIC_BASE_URL为http://IPv4[:port]；生产配置必须HTTPS。该开关不放松会话/签名/鉴权，明文HTTP仅演练，不能作为正式微信上线地址。


## 正式域名HTTPS配置（2026-10-28）

默认环境模板现为PUBLIC_BASE_URL=https://api.siteforsk.ink、NODE_ENV=production、HTTP_ALLOW_INSECURE=false、WRITE_ENABLED=false。这不会自动修改服务器、签发证书或开放业务写入；AppSecret暂缺时readyz仍应503。HTTPS域名的request/uploadFile/downloadFile合法域名按实际前端调用方式配置在微信后台，头像签名URL使用同一HTTPS基址。

### 首次证书签发

由部署负责人核对域名A记录指向当前服务器；如配置AAAA记录，IPv6也必须指向可达服务器。安全组/防火墙放行80（HTTP-01续期使用）和443，应用3000及MySQL3306继续仅本机。保留现有IP演练虚拟主机，不覆盖default_server，不修改身份校验或IP演练代码。

先只部署以下80端口命名虚拟主机；首次没有真实证书时不要直接启用完整nginx.conf的443段，否则Nginx配置检查会失败：

```nginx
server {
    listen 80;
    server_name api.siteforsk.ink;
    access_log off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 503; }
}
```

安装Ubuntu发行版提供的Certbot或官方支持的安装方式后，负责人执行（命令仅供部署，不在本任务执行）：

```sh
sudo install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt --domain api.siteforsk.ink --cert-name api.siteforsk.ink
```

Certbot交互填写由负责人选择的联系邮箱并确认条款。成功后核对实际证书名称与路径，再把同一命名虚拟主机替换为本目录完整nginx.conf，执行nginx -t成功后reload。模板使用真实签发后的fullchain.pem/privkey.pem路径，不提供占位或自签名证书。若Certbot因已有同名证书使用了带后缀目录，先核对certbot certificates，再同步模板路径，不能假定文件已存在。

模板80端口保留ACME目录，其他路径308到固定HTTPS域名；443只反代本机3000，转发HTTPS协议标记。access_log关闭以避免签名图片URL查询参数落入默认访问日志；后端已有不含正文和凭据的trace/状态/耗时日志，需要额外Nginx访问日志时使用不含query/Authorization的专门格式。

### 免费证书自动续期与reload

Let’s Encrypt证书通过Certbot续期。核对安装方式创建的systemd timer或cron，使用已有的自动续期机制，不重复叠加调度。负责人在/etc/letsencrypt/renewal-hooks/deploy/scoreboard-nginx创建可执行的root拥有脚本（0755、普通用户不可写）：

```sh
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
```

deploy hook仅在实际续期成功后触发，先检查Nginx配置再reload。保留80端口ACME webroot目录与规则，证书私钥由root保管，不复制到代码、应用环境模板或普通日志。验证自动续期和hook：

```sh
sudo certbot renew --dry-run --run-deploy-hooks
```

最后验收HTTPS证书域名/链与有效期、HTTP跳转、/healthz=200；缺登录凭据时/readyz=503、停写时POST /api=503 MAINTENANCE是独立的预期状态，不因HTTPS成功而开启WRITE_ENABLED。最终配置和实测结果由技术负责人写部署报告。

配置依据：[Nginx SSL模块](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)、[Certbot webroot与续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html)。
