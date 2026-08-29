<!--
  Author: MoyuZJ
  Team: LinearTeam
  Contact: linearteam@foxmail.com
  Made by MoyuZJ in China with ♥
-->

# MySQL 插件（mysql-plugin）

把 **MySQL 作为主数据库**的驱动插件（`type: driver`）：后台配置连接、把现有 SQLite 数据迁移到 MySQL，
重启站点后 MySQL 替代默认 SQLite 承载业务数据；基础设施 SQLite 始终保留插件状态与站点设置。

> 本仓库是 LinearPress 插件 **mysql-plugin** 的独立开发仓库。
> 依赖：`mysql2`；生命周期：`preboot: true`（配置存在时在预启动阶段接管 Session 存储）。

## 插件化的优势

- **服务替换机制**：无需 fork 核心——在 `preboot` 替换 `sessionStoreFactory`、在 `bootstrap` 用 `replaceService` 替换全部业务服务，核心控制器按请求从 Context 解析，替换即刻生效。
- **基础设施边界不变**：插件状态、设置、会话迁移记录仍在本地 SQLite，`mysql-plugin` 只接管业务数据。
- **可回退**：后台「断开」删除配置回退 SQLite，不影响已启动的数据结构与业务。

## 使用

```bash
# 1. 复制到运行目录（目录名必须与插件 id 一致）
cp -r Plugins/mysql-plugin src/plugins/

# 2. 安装依赖
cd src/plugins/mysql-plugin && npm install      # 或站点根目录 npm install mysql2
```

重启站点，后台「插件」页确认启用；配置入口 `/admin/plugins/mysql-plugin`（侧栏「MySQL 插件」）。

## 配置与迁移

- 配置文件：`data/mysql-plugin.json`（不依赖基础设施 SQLite，保证预启动阶段可读），字段 `host / port / user / password / database`；**密码明文存服务器端，请勿把 data 目录纳入版本控制**。
- 后台「测试连接」仅验证连通性，不写入配置文件；「断开」删除文件回退 SQLite。
- 迁移入口：填写连接 → 测试连接 →「保存并迁移」→ 重启站点。

## 与 OOBE 的关系

插件不改变 OOBE 流程。未配置时不启动任何 MySQL 逻辑，OOBE、SQLite 建库、超级管理员创建与默认完全一致；配置并迁移、重启后站点照常运行，只是数据落点换成了 MySQL。

## 本地开发：怎么拉 / 怎么改 / 怎么跑

```bash
git clone <本仓库地址> LinearPress/Plugins/mysql-plugin
cd LinearPress/base
npm install && npm run db:init
sh scripts/sync-plugins.sh mysql-plugin
npm run dev
```

## 目录结构

```text
mysql-plugin/
├── plugin.json            # Manifest（type: driver, preboot: true）
├── index.ts               # 入口：preboot/bootstrap/activate 分阶段接管
├── src/
│   ├── config.ts          # 连接配置模型 + 读写 data/mysql-plugin.json
│   ├── mysql.ts           # 连接池与基础查询适配
│   └── services.ts        # 业务服务（posts/users/comments/…）MySQL 实现
└── views/mysql-plugin/    # 后台设置页（连接/测试/迁移）
```

## 注意事项

- 迁移由后台流程执行：先备份语义（保留现有数据），再逐表灌入 MySQL；重启生效。
- 若后续把连接池改为 Cordis Effect，必须保证 Fiber 销毁时先释放连接再卸载数据库服务。

## 贡献与发布

- conventional commits；提交前 `cd base && npm run typecheck`
- 版本：`git tag v1.0.0 && git push --tags`
- License：MIT（见仓库 LICENSE）