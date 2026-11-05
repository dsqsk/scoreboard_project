# 工程检查

状态：完成（2026-10-22）。

- Prettier 3统一格式；ESLint 10及typescript-eslint检查JS/TS，React Hooks调用规则启用，eslint-config-prettier消除格式冲突。
- npm run check串联format:check、lint（零警告）、typecheck；format和lint:fix提供修复入口。
- 类型检查覆盖三个工作区、后端测试、前端预览工具；开发环境Node 22.13以上的22.x或24及以上。
- 统一检查及依赖树验证通过；前端75项、后端53项测试和对应构建通过。负向输入验证格式错误及条件Hook会被拦截。
- 构建产物、设计稿、历史文档、任务及报告不参与格式化；业务源码未被排除。本轮无部署、云端数据修改或提交钩子变更。

执行说明见README代码检查；分端结果见reports/fe.md和reports/be.md。
