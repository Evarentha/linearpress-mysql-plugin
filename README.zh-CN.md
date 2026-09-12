# MySQL 插件（mysql-plugin）

[![LinearPress](https://img.shields.io/badge/LinearPress-plugin-7C3AED.svg)](https://www.npmjs.com/package/@evarentha/linearpress) [![npm](https://img.shields.io/npm/v/@evarentha/linearpress-mysql-plugin.svg)](https://www.npmjs.com/package/@evarentha/linearpress-mysql-plugin) [![Node.js](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org) [![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

[English](README.md) | **简体中文**

LinearPress 的数据库驱动插件。使 MySQL 成为主业务数据库，本地基础设施 SQLite 继续保管插件注册表与站点设置，现有数据经单次事务整体迁移。开始前须知三点：迁移将先清空目标表；DDL 失败将直接中止启动，绝不静默回退至 SQLite；需要一台可达的 MySQL 服务器，且账号具有建库建表权限。

## 安装

```bash
git clone https://github.com/Evarentha/linearpress-mysql-plugin.git src/plugins/mysql-plugin
```

目录名必须与插件 id 一致。本插件比常规插件多一项依赖，安装插件文件后请在站点根目录（或 `src/plugins/mysql-plugin` 内）执行：

```bash
npm install mysql2
```

随后重启 LinearPress；也可以在 `base` 检出中同步，或在后台插件页上传 ZIP、填写 npm 包名。后台菜单的「MySQL 插件」指向设置页，旧路径 `/admin/plugins/mysql-plugin` 将重定向至此。

## 切换至 MySQL

全部操作在 `/admin/plugins/mysql-plugin/settings` 完成，由基础权限 `plugin:manage` 守护：

1. 填写主机、端口、用户、密码与库名。
2. 先执行「测试连接」，该操作仅验证连通性，不写入任何数据。
3. 执行「保存并迁移」。系统将要求确认并警告目标表将被全量覆盖，随后将 SQLite 数据复制至 MySQL。
4. 重启站点。业务数据此后写入 MySQL。

若干细节：设置持久化于 `data/mysql-plugin.json`，权限为 `0600`，因密码以明文存放其中，`data` 目录不应纳入版本控制；库名先通过 `^[A-Za-z0-9_]+$` 校验，方可拼接进任何语句；密码留空即保留已存值；「断开」将删除配置文件，重启后站点恢复使用 SQLite。

## 接管机制

插件声明 `preboot: true`，接管在站点开始服务之前启动。`preboot` 阶段创建连接池、建立表结构（utf8mb4，池上限 5，表结构与基础 SQLite 完全一致：`sessions`、`groups`、`users`、`posts`、`comments`，索引同步对齐），并将会话存储切换至 MySQL。`bootstrap` 阶段替换全部业务服务（`databaseService`、`auth`、`users`、`posts`、`comments`、`groups`、`permissions`），采用方言正确的 MySQL 实现。`activate` 阶段注册后台界面。

替换发生于同一组接口之后，基础 Hook 全部照常触发，插件生态的其余部分不受影响。经由数据库服务存取数据的插件，例如 media-library 的 `media_library` 表，自动跟随 MySQL。迁移本身按 groups、users、posts、comments、sessions 的顺序在单个事务内复制，先清空目标行、仅从 SQLite 读取，SQLite 原样保留作为迁移事实源。OOBE 流程不受影响：没有配置文件时 MySQL 逻辑完全不执行。

## 常见问题

**迁移会破坏数据吗？** 迁移先清空目标 MySQL 表，再从 SQLite 全量复制；SQLite 侧全程不被修改，原始数据始终完好。

**如何回退到 SQLite？** 在设置页点击「断开」（该操作删除配置文件），随后重启，站点恢复使用 SQLite，数据完整保留。

**MySQL 连不上或建表失败会怎样？** 启动直接中止，插件绝不静默回退至 SQLite。修复连接，或删除 `data/mysql-plugin.json` 后重启。

## 许可证

本项目以 GPL-3.0-or-later 许可发布，Copyright (C) 2026 Evarentha，完整文本见 [LICENSE](LICENSE)。
