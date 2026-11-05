# FE：迁移后联调

状态：2026-10-28，新端正式库已开放，用户确认真实登录与原房间展示通过。

- 使用https://api.siteforsk.ink、npm run dev:miniapp:http；禁止旧cloud/mock watcher覆盖产物，不自动回退云函数。
- 验收原房间/最近房间/历史/头像；真实记分仅由用户按实际需要操作，采集认领/更正与热状态端到端时延。
- 保留requestId、在途锁、乱序保护；未知写入结果不可换ID重试。
- 原云api保持MAINTENANCE；未授权发布微信正式版，不启动此前被拒提权的完整Taro构建。
- 报告只写验证结论和问题，写reports/fe.md；服务器状态见reports/server-migration.md末节。
