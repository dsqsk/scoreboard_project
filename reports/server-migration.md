# 轻量服务器迁移交付

状态：2026-10-28最终数据已迁移至scoreboard_prod_20261028，新端WRITE_ENABLED=true，旧云函数api维护停写；用户确认HTTPS小程序能真实登录并看到原房间。未发布微信正式版，性能与长期运维验收待完成。以下早期节为历史记录，以末节最终切换结果为准。

- 目标：Ubuntu-amvy，cn-beijing，101.201.236.27，2核2GB/40GiB ESSD/Ubuntu24.04。Node22.23.4、MySQL8.0.46、Nginx；实际可见内存1613MiB，最终available约752MiB。
- 服务：systemd scoreboard/nginx/mysql均active，应用以scoreboard账户运行；外部80转本机3000，MySQL3306/33060仅127.0.0.1。未新增收费资源或升级套餐。
- 当前部署：/opt/scoreboard/current → /opt/scoreboard/releases/final-20261027/http。上一版/opt/scoreboard/releases/rehearsal-20261027/http保留。最终部署包SHA256：ec442ec2da632aeff58da7013f9d5cedbd1162e96f550786d931bfab5c07cf9c。
- 配置：/etc/scoreboard/scoreboard.env；数据库迁移账户/etc/scoreboard/migrate.env。密码/签名密钥仅服务器生成并保存，不进仓库或聊天。应用账户无DDL权限，迁移账户单独保管。
- 当前库scoreboard_rehearsal，WRITE_ENABLED=false、HTTP_ALLOW_INSECURE=true、NODE_ENV=development；PUBLIC_BASE_URL=http://101.201.236.27。WECHAT_APP_ID保持原小程序，AppSecret未配置。原云端仍为正式唯一写入来源，未停旧服务。

## 已验证

- 原环境17集合在线导出210条，0个cloud头像引用；敏感原始文件只存/private/tmp/scoreboard-migration-20261027（目录0700、文件0600）及服务器受限目录，不纳入仓库。在线导出不是停写一致快照，不作为正式切换数据。
- 本地validate及服务器schema/stage/activate/verify/export/validate均成功；原/导入/反向导出摘要完全一致：ceb4405f58bdda475095085f84955d53e55f66f3899f6a1cee9dcbd7e264b169。
- 真实MySQL smoke通过：准备活动、认领、同ID回执重放、异载荷拒绝、同牌并发仅一次成功、事务回滚、结算；测试数据自动清理，导入的210条记录摘要未变化。
- mysqldump备份/var/backups/scoreboard/rehearsal-20261027.sql恢复到scoreboard_restore_test，完整摘要校验通过；同机备份恢复已演练，不等同于生产异机自动备份已完成。
- 外部GET http://101.201.236.27/healthz返回200 {ok:true}；一次本机公网请求约59ms，仅健康接口样本。外部POST /api返回503 MAINTENANCE；本机/readyz503符合缺失凭据预期。不能据此宣称真实登录/200ms记分已验收。
- 全库format/lint/typecheck通过；后端77项、前端100项测试及微信桥/传输隔离/开发IP限制验证通过；HTTP构建通过。未重试此前被拒提权的Taro构建，未发布小程序。

## 后续启用条件

1. 用户在服务器受限配置文件中补WECHAT_APP_SECRET，勿发聊天。真实登录与双用户记分联调在隔离数据进行。
2. HTTPS验证成功并完成微信合法域名配置后，停止旧watch，使用npm run dev:miniapp:http重新编译。IP入口仅保留显式调试用途。
3. siteforsk.ink备案已由用户确认；api.siteforsk.ink的A记录此前创建为此IP。按apps/cloud/deploy/README.md先配置ACME、签发证书，再启用443并验证；保持WRITE_ENABLED=false。
4. 完成代表性并发、真机端到端P95目标、鉴权/撤权、异机自动备份及恢复、旧端停写与无损回退工具验收；当前反向导出仅证明无损归档，不代表已实现对旧云数据库的完整反向合并。
5. 维护窗口内排空旧请求后重新导出一致数据，导入全新正式库并核验；只有新端作为唯一写入来源时才打开WRITE_ENABLED。新端写入后不能直接回退到陈旧旧库。

## HTTPS配置交付（2026-10-28）

- FE：.env.http默认HTTPS域名并禁止不安全HTTP；文档补齐request/downloadFile合法域名及旧watch清理。100项测试、真实配置加载回归通过。
- BE：环境模板改production/HTTPS；Nginx包含ACME、80跳转443、TLS反代；部署文档提供证书签发与续期hook，保留停写。未在服务器执行nginx -t。
- 全库npm run check通过（格式、lint、typecheck）；未执行此前被拒绝提权的完整Taro构建、未发布小程序。
- 阻塞：阿里云MCP返回401；用户重新授权刷新后实例查询仍未返回，已停止等待。未执行服务器变更。公网HTTPS探测SSL_ERROR_SYSCALL、HTTP状态000，不能视为HTTPS已可用。
- 下一步：恢复服务器操作通道或使用控制台终端完成上述证书部署；验证TLS后再配微信合法域名和隔离联调。AppSecret仅在服务器配置，正式数据切换另行执行。

## 迁移准备实测（2026-10-28）

- MCP已恢复。scoreboard/nginx/mysql均active；应用仍为final-20261027、scoreboard_rehearsal、WRITE_ENABLED=false，旧云端未改动。
- AppSecret已配置（仅检查是否非空，未输出值）；healthz/readyz均200，不等于真实微信登录已验收。
- 已备份Nginx及受限环境文件至/var/backups/scoreboard/https-20261028；安装Certbot及其timer，新增域名80端口ACME虚拟主机，nginx -t通过。未更改应用环境及现有IP虚拟主机。
- 证书签发失败：验证机构请求被403拒绝。服务器内域名/回环读取测试文件均200；外部公网返回Server: Beaver、403、Non-compliance ICP Filing，页面指向阿里云备案拦截。证书未签发、443及续期hook未启用。
- 当前阻塞：核对siteforsk.ink的ICP备案/阿里云接入状态，并解除公网域名拦截；不要反复申请证书。解除后签发证书→启用HTTPS及production配置（保持停写）→续期演练→微信合法域名及隔离联调→性能/备份/回退验收→维护窗口最终迁移。

## 手动证书部署完成（2026-10-28）

- 用户提供DigiCert/Encryption Everywhere证书，域名api.siteforsk.ink，含中间证书；私钥匹配。有效期至2027-01-25 07:59:59北京时间，手动证书不由Certbot自动续签。
- 证书与私钥加密传输，安装至/etc/nginx/ssl/scoreboard-20261028，目录0700、私钥root:root0600；临时传输密钥及文件已删除。
- Nginx域名443已启用，nginx -t/reload成功，保留原IP虚拟主机；变更前备份在/var/backups/scoreboard/https-20261028。
- 应用PUBLIC_BASE_URL=https://api.siteforsk.ink、NODE_ENV=production、HTTP_ALLOW_INSECURE=false、WRITE_ENABLED=false；重启后服务正常。仍使用演练库，未切正式数据。
- 公网curl未跳过证书校验：HTTPS healthz/readyz均200；服务端/api返回MAINTENANCE。80端口公网仍被Beaver返回403备案接入拦截，HTTP跳转及ACME续期未通过，不能标记已解决。
- 下一步：微信request/downloadFile合法域名配置、隔离真实登录和记分联调；继续完成性能、异机备份及切换验收。证书到期前须续签并部署，或接入拦截解除后另行迁移至自动续期证书。

## 最终数据迁移与开放（2026-10-28）

- 原环境scoreboard-d7giv4iri8369fe43：仅api/health两个函数，无timer；17集合均ADMINONLY；api默认别名指向LATEST，无灰度权重。旧api已替换为固定MAINTENANCE响应并两次实测；health不变。禁止直接重新部署旧业务api。
- 原api部署包保存在本机受限目录/private/tmp/scoreboard-final-20261028/old-api.zip，SHA256 dc4715446a5e584efa75e010f22260b431a4f46713a1d838e3714df1791b4220。该目录为临时存储，后续需转入持久受控备份。
- 旧端维护部署确认后等待至少25秒（原timeout20秒），两次完整分页读取一致；consistentSnapshot=true。17集合213条，完整校验通过；旧云端原数据未删除。
- 数量：users2、rooms2、room_members3、room_codes2、activities2、activity_scores4、activity_cards30、commands69、user_room_signals3、notification_outbox47、result_slots0、rate_limits4、point_changes41、point_results1、point_totals1、da_a_entries0、da_a_totals0。旧云头像引用0。
- 最终摘要032e7fd4dcc0c4d7de8da4fb900a49884ee17f0fa1d34b397f6ea9a66810c818；全新正式库scoreboard_prod_20261028完成schema/stage/activate/verify，MySQL反向导出摘要一致。演练库保留，不覆盖。
- 服务器受限备份目录/var/backups/scoreboard/final-20261028：final-snapshot.json、mysql-export.json、mysql-baseline.sql、scoreboard.env.before。本机另保存最终快照和停写证据，未入仓库；传输用临时密钥/文件已删除。
- mysql-baseline.sql恢复到scoreboard_final_restore_test，摘要一致；在该隔离恢复库通过prepare/claim/receipt-replay/payload-mismatch/same-card-race/transaction-rollback/post/imported-data-unchanged全部烟测，清理后再次摘要一致。未用正式库制造测试成绩。
- 应用已切scoreboard_prod_20261028，保持production/HTTPS，WRITE_ENABLED=true；旧端继续维护，无双写。readyz200；无鉴权api401，空登录参数400。
- 用户确认真实微信登录成功并看到原房间。服务器自身公网HTTPS200；负责人本机本轮公网TLS握手中断，用户实际链路已通过，不能据此宣称所有网络稳定。80备案拦截仍待处理。
- 未完成：真实认领/更正端到端P95及代表性负载、异机自动加密备份和持久归档、完整反向合并回旧库工具、微信正式版发布。200ms目标未验收。
- 回退：新端开放后不得直接恢复旧快照或重启旧api写入；先两端停写并备份最新MySQL，完成无损回迁核验，或优先修复新端。手动证书到期2027-01-25 07:59:59北京时间，需提前续签。
