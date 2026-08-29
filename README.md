<!--
  Author: MoyuZJ
  Team: LinearTeam
  Contact: linearteam@foxmail.com
  Made by MoyuZJ in China with ♥
-->

# MySQL 插件 · MySQL Plugin

A driver plugin (`type: driver`) that makes **MySQL the primary database**：configure the connection in admin, migrate existing SQLite data to MySQL, restart — MySQL takes over all business data. The infrastructure SQLite always keeps plugin state and site settings.

把 **MySQL 作为主数据库**的驱动插件（`type: driver`）：后台配置连接、把现有 SQLite 数据迁移到 MySQL，重启站点后 MySQL 替代默认 SQLite 承载业务数据；基础设施 SQLite 始终保留插件状态与站点设置。

> Independent plugin repository for LinearPress **mysql-plugin**. Dependency：`mysql2`；lifecycle：`preboot: true`.
> 本仓库是 LinearPress 驱动插件 **mysql-plugin** 的独立仓库。依赖 `mysql2`，`preboot: true`。

## Why Plugins? / 插件化的优势

- **Service replacement mechanism** —— no forking：`preboot` swaps `sessionStoreFactory`；`bootstrap` uses `replaceService` for every business service；core controllers resolve from Context at request time, so replacement applies instantly.
  **服务替换机制**——无需 fork 核心，分阶段替换 Session 工厂与全部业务服务。
- **Infrastructure boundary unchanged** —— plugin states, settings and migration records stay in local SQLite.
  **基础设施边界不变**。
- **Rollback-friendly / 可回退**——「断开」deletes the config and falls back to SQLite.

## Usage / 使用

```bash
# 1. copy to runtime dir（目录名必须与插件 id 一致）
cp -r Plugins/mysql-plugin src/plugins/

# 2. install dependency / 安装依赖
cd src/plugins/mysql-plugin && npm install      # or site root：npm install mysql2
```

Restart，confirm enabled in「插件」page；config at `/admin/plugins/mysql-plugin`.

## Config & Migration / 配置与迁移

- Config file：`data/mysql-plugin.json`（readable at preboot，independent of infrastructure SQLite）；fields `host / port / user / password / database`；**password is stored plaintext on the server — never commit the data directory**.
- Admin「测试连接」only checks connectivity（no write）；「断开」deletes the file and falls back to SQLite.
- Migration：fill connection → test →「Save & migrate」→ restart.

## OOBE / 与 OOBE 的关系

The plugin does not change OOBE. Without config it starts no MySQL logic — OOBE, SQLite setup and super-admin creation behave exactly like default；after migration & restart the site runs normally with data on MySQL.

不改变 OOBE 流程；未配置时不启动 MySQL 逻辑。

## Local Development / 本地开发：怎么拉 / 怎么改 / 怎么跑

```bash
git clone https://github.com/Averithen/linearpress-mysql-plugin LinearPress/Plugins/mysql-plugin
cd LinearPress/base
npm install && npm run db:init
sh scripts/sync-plugins.sh mysql-plugin
npm run dev
```

## Directory / 目录结构

```text
mysql-plugin/
├── plugin.json            Manifest（type: driver, preboot: true）
├── index.ts               entry：preboot/bootstrap/activate staged takeover
├── src/
│   ├── config.ts          connection model + data/mysql-plugin.json IO
│   ├── mysql.ts           pool & query adaptation
│   └── services.ts        MySQL implementations of business services
└── views/mysql-plugin/    admin settings page（connect/test/migrate）
```

## Notes / 注意事项

- Migration runs in admin flow（keeps existing data, loads tables into MySQL, restart takes effect）.
- If the pool becomes a Cordis Effect later，release the connection before unregistering services on Fiber disposal.

## Contribute & Release / 贡献与发布

- conventional commits；`cd base && npm run typecheck` before commit
- Version：`git tag v1.0.0 && git push --tags`
- License：MIT（LICENSE）