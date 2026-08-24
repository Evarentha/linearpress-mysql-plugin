<!--
  Author: MoyuZJ
  Team: LinearTeam
  Contact: linearteam@foxmail.com
  Made by MoyuZJ in China with ♥
-->

# LinearPress MySQL 插件

把 MySQL 作为主数据库的驱动插件（`type: driver`）：在后台配置连接、把现有 SQLite 数据迁移到 MySQL，重启站点后 MySQL 替代默认 SQLite 承载业务数据。

- **插件 id**：`mysql-plugin`
- **版本**：1.1.0
- **类型**：`driver`（`preboot: true`，配置存在时在预启动阶段接管 Session 存储）
- **依赖**：`mysql2`（^3.11.5）
- **生命周期运行时**：LinearPress Cordis + Express 兼容层。`preboot` / `bootstrap` 仍保持原有顺序；基础设施 SQLite 边界不变。

迁移后的插件由 Cordis Fiber 持有。连接池仍在 `preboot` 创建并在 `deactivate` 关闭；如果后续将连接池改为 Cordis Effect，必须保证 Fiber 销毁时先释放连接，再卸载数据库服务。


1. 将本插件目录整体复制到站点 `src/plugins/mysql-plugin/`（目录名必须与插件 id `mysql-plugin` 一致，插件管理器会校验）。
2. 安装依赖：在站点根目录执行 `npm install mysql2`，或进入插件目录执行 `npm install`。
3. 重启站点，进入后台「插件」页确认插件已启用；配置入口为 `/admin/plugins/mysql-plugin`（侧栏菜单「MySQL 插件」）。

```bash
cp -r Plugins/mysql-plugin src/plugins/
cd src/plugins/mysql-plugin && npm install
```

---

## 与 OOBE 的关系

插件**不改变 OOBE 流程**。未配置时，插件不启动任何 MySQL 逻辑，OOBE、SQLite 建库、超级管理员创建等行为与默认完全一致；配置并迁移、重启后，站点照常运行，只是数据落点换成了 MySQL。

---

## 配置文件

- 路径：`data/mysql-plugin.json`（站点数据目录下；不依赖基础设施 SQLite，保证预启动阶段可读）。
- 由后台「保存并迁移」成功时写入，字段：

| 字段 | 说明 |
| --- | --- |
| `host` | MySQL 主机地址 |
| `port` | 端口（默认 3306） |
| `user` | 用户名 |
| `password` | 密码（明文保存在服务器端，请勿把 data 目录纳入版本控制） |
| `database` | 目标数据库名，只允许字母、数字、下划线 |

- 后台「测试连接」只验证连通性，**不写入**配置文件；「断开」删除该文件并回退 SQLite。

---

## 迁移

入口：后台 `/admin/plugins/mysql-plugin` → 填写连接信息 →「测试连接」→「保存并迁移」→ 重启站点。

迁移语义：

- 以 **SQLite 为数据源**，将 `groups / users / posts / comments / sessions` 五张表全量复制到目标 MySQL（先**清空/覆盖**目标表中已有内容，再逐行写入；整个过程在同一事务内，失败自动回滚，不会留下半截数据）。
- 目标数据库若不存在会被自动创建（`utf8mb4`）。
- **SQLite 保留作为基础设施**（插件启停状态、回退依据），迁移后**不会从 MySQL 反向同步回 SQLite**。
- 迁移成功后提示重启：MySQL 相关服务在启动阶段（preboot / bootstrap）接管，重启后正式生效。

> 提示：迁移会覆盖目标库已有数据，执行前请确认目标 MySQL 实例与数据库可覆盖（必要时先备份）。

---

## 回退

1. 后台 `/admin/plugins/mysql-plugin` →「断开」（清除配置；或直接删除 `data/mysql-plugin.json`）。
2. 重启站点：未配置时插件退出接管，恢复使用 SQLite，原有数据原样保留。

---

## 故障恢复

- **迁移失败**：迁移在事务中执行，失败自动回滚，目标 MySQL 表保持迁移前的状态。
- **MySQL 不可用导致站点异常**：删除 `data/mysql-plugin.json` 后重启站点即可恢复 SQLite 运行；SQLite 数据库从未被破坏，数据完整。
- **连接反复失败**：先在后台「测试连接」确认主机 / 端口 / 账号 / 数据库名；数据库名非法（含字母、数字、下划线以外的字符）时迁移会被拒绝。
- **插件停用/卸载**：停用需重启后完整生效；卸载会清理配置与插件目录，站点回到 SQLite。

---

## 目录

```
mysql-plugin/
├── plugin.json          # 插件清单（id=mysql-plugin, preboot=true, views=views）
├── index.ts             # 生命周期 + 后台设置路由与三个操作接口
├── src/
│   ├── config.ts        # data/mysql-plugin.json 配置读写与校验
│   ├── mysql.ts         # 连接池 / 建库建表 / SQLite→MySQL 迁移 / 连接测试
│   └── services.ts      # MySQL 版业务服务与 Session Store
├── views/
│   └── mysql-plugin/
│       └── settings.ejs # 后台设置页（复用 admin 布局与 admin.css）
└── README.md
```