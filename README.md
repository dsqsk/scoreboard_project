# 朋友记分

Taro + React + TypeScript 微信小程序，微信云开发后端。仅面向微信端。

## 设计文档

- 当前交接：需求以[PRD](docs/PRD.md)为准；[技术设计](docs/tech-design.md)、[接口契约](docs/api-contract.md)、[前端任务](tasks/fe.md)、[后端任务](tasks/be.md)、[前端报告](reports/fe.md)、[后端报告](reports/be.md)。任务和报告只保留结论、约束及验证状态。

- [产品需求](docs/PRD.md)
- [V4设计交付](docs/design/v4-handoff/HANDOFF.md)
- [前端技术设计](docs/technical/FRONTEND.md)：功能拆分、交互状态、复用组件与同步Interface。
- [后端技术设计](docs/technical/BACKEND.md)：功能拆分、命令契约、事务、权限、通知及最新数据模型增量。
- [原数据模型](docs/DATA-MODEL.md)：杀球新增牌状态等差异以最新后端技术设计为准。

- [CloudBase接入状态](docs/technical/CLOUDBASE-SETUP.md)：已完成国内站授权、环境绑定及真实云模式构建验证。

## 仓库结构

- `apps/miniapp`：Taro 前端，使用 Taro Vite 编译器。
- `apps/cloud`：云函数 TypeScript 源码及部署包构建。
- `packages/shared`：前后端共享类型与后续计分函数。
- `docs`：需求、设计与数据模型。

## 开发

开发环境要求Node.js 22.13以上的22.x，或24及以上版本。

### 代码检查

- `npm run check`：依次检查Prettier格式、ESLint（零警告）及全部工作区类型。
- `npm run format`：统一源码、脚本、配置和CSS格式。
- `npm run lint:fix`：修复ESLint支持自动修复的问题。
- `npm run typecheck`：独立类型检查，包括后端测试与前端预览工具。

Prettier负责格式，ESLint负责JS/TS规则与React Hooks调用规则；使用eslint-config-prettier关闭格式冲突，不在ESLint内重复运行Prettier。设计稿、历史文档、任务/报告及生成目录不参与格式化。两者分工见[Prettier官方说明](https://prettier.io/docs/integrating-with-linters)。提交交付前运行`npm run check`，业务变更另跑相应测试及构建。

1. 根目录执行 `npm ci`，按工作区的 package-lock.json 安装依赖。
2. 执行 `npm run typecheck`、`npm run build`。
3. 微信开发者工具导入根目录；将 project.config.json 的测试 AppID 替换为真实 AppID。
4. 执行 `npm run dev` 开发前端。
5. 后端联调先按 [基础接口联调说明](apps/cloud/FOUNDATION.md) 创建集合和索引，再上传 `apps/cloud/dist/api` 和 `health` 并云端安装依赖。

后端已实现可信身份、带玩法的房间创建/加入、成员和最近房间查询、活动准备及快照；联调请求见 [FOUNDATION.md](apps/cloud/FOUNDATION.md)。计分业务、实际发牌与通知投递尚未实现，api已部署为Event，微信身份与数据库链路尚未联调。health 仅检查入口连通性，勿提交凭据。

依赖安装与验证结果见本次交付说明。Taro 4.3 的 Vite runner 使用 Vite 4。云函数构建目标 node18 是语法兼容下限，部署时选择云平台支持的运行时。

后端分层和入口约定见 [云函数说明](apps/cloud/README.md)。共享接口类型位于 packages/shared/src/contracts，纯计分函数预留在 scoring 目录。

## 初始化验证

- 已安装依赖并生成根目录 package-lock.json。
- npm run typecheck：通过。
- npm run build：云函数与微信小程序生产构建通过。
- 构建后的 health 函数：空对象请求成功，包含未知字段的请求被参数校验拒绝。
- 尚未在微信开发者工具或真实云环境验证，未部署业务功能。
- npm 安装审计报告40项漏洞告警（含高危/严重级别），尚未完成影响分析；未执行可能破坏兼容性的强制升级。上线前需另行处理。

## 前端第一步

已完成V4首页、先选模式创建、房间码/分享加入确认及房间框架，默认独立Mock模式。演示房间码为628391；不会连接真实后端或跨设备同步。

- 测试：`npm run test --workspace @scoreboard/miniapp`
- DOM走查：`npm run preview:dom --workspace @scoreboard/miniapp`，仅用于开发验证，不是H5发布目标。
- 交付与边界：[前端第一步说明](docs/development/FRONTEND-STEP-1.md)

## 后端基础能力验证（2026-10-21）

- 全工作区 TypeScript 类型检查通过，api/health云函数构建通过。
- 后端19项本地测试通过，覆盖幂等、权限、固定名单、回滚及SDK适配。
- api部署包的非法参数检查及health部署包冒烟检查通过。
- 本地事务Adapter不代表真实云数据库并发已验收；通知outbox尚无投递worker，数据库权限与真机调用需按联调说明验证。

## CloudBase真实云模式

项目已绑定上海环境 `prod-d5g2mjphqdcb5bb94`。执行 `npm run cloud:check` 核查环境，`npm run dev:miniapp:cloud` 启动真实云模式；默认 `npm run dev` 仍为本地演示。云函数构建后按 [接入状态](docs/technical/CLOUDBASE-SETUP.md) 继续部署，当前未进行线上资源初始化或业务端到端验证。

## api部署状态更新

api已在绑定环境部署成功，云端状态Active，Event类型、index.main入口，空参数调用返回预期INVALID_ARGUMENT。上传前运行 `npm run build:cloud && npm run check:cloud-package`；控制台应选择事件函数，不应将此包创建为HTTP/Web函数。完整记录见 [CloudBase接入说明](docs/technical/CLOUDBASE-SETUP.md)。
