# 仓库组织

采用轻量 Monorepo：npm workspaces 管理前端、云函数与共享包。当前代码由同一产品驱动，接口和计分类型经常一起变化，同一提交可以同步调整前后端，更适合放在同一 Git 仓库。

不使用 Nx/Turborepo：当前只有两个构建入口，不需要远程缓存或复杂任务调度。云函数和小程序分别构建、分别部署，Monorepo 不意味着绑定发布。

依赖方向：miniapp → shared；cloud → shared；shared 不引用 Taro、微信身份或数据库SDK。云函数部署必须打包共享代码，不上传依赖工作区软链接的源码目录；当前 esbuild 构建生成独立部署目录。

npm 版本通过根目录安装与锁文件统一管理。当前已生成 package-lock.json，后续使用 npm ci 复现安装。仓库目前还没有初始化 Git；已有文档与工程应一起纳入后续首次提交，不自动创建远程或推送。

Taro 已提供 Vite 编译器配置，使用 compiler: vite；保留 Taro 的微信平台编译能力，不是普通 H5 Vite 项目。参考：https://docs.taro.zone/docs/config-detail/
