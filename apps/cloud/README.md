# 云函数后端

使用微信云函数main入口，不使用Express。当前已实现身份、房间创建/预览/加入、成员和最近房间查询、活动准备及快照。

- functions：Zod校验和可信云调用组合入口，api与health分别构建。
- services：身份、成员授权、幂等命令、房间/活动业务与规则配置。
- repositories：事务数据访问；wx-store封装SDK运行时类型差异。
- infrastructure：微信SDK、可信身份、ID、错误处理。
- test：接口级服务测试、故障注入事务Adapter及SDK适配测试。

从仓库根目录执行：

```sh
npm run typecheck
npm run test --workspace @scoreboard/cloud
npm run build:cloud
```

每个 `functions/<name>/index.ts` 打包到 `dist/<name>/index.js`；Zod与共享代码打包，wx-server-sdk云端安装，不依赖工作区软链接。

完整请求、支持范围、部署集合和权限见[基础接口联调说明](./FOUNDATION.md)。核心流程已通过本地测试，api已部署为Event并通过云端参数校验调用；身份与数据库业务还需微信端联调。记分账本、实际发牌及实时通知投递尚未实现。

health仅返回静态服务状态，不读取数据库，不证明身份/权限/事务正常。
