# MySQL Plugin

[![LinearPress](https://img.shields.io/badge/LinearPress-plugin-7C3AED.svg)](https://www.npmjs.com/package/@evarentha/linearpress) [![npm](https://img.shields.io/npm/v/@evarentha/linearpress-mysql-plugin.svg)](https://www.npmjs.com/package/@evarentha/linearpress-mysql-plugin) [![Node.js](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org) [![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

The database driver plugin for LinearPress. It makes MySQL the primary business database, keeps the local infrastructure SQLite in charge of the plugin registry and site settings, and migrates existing data in one transactional shot. Read this first: the migration clears the target tables; a DDL failure aborts startup rather than silently falling back to SQLite; and you need a reachable MySQL server with credentials allowed to create a database and tables.

## Install

```bash
git clone https://github.com/Evarentha/linearpress-mysql-plugin.git src/plugins/mysql-plugin
```

The directory name must equal the plugin id. This plugin carries one dependency beyond the base site; after installing the plugin files, add it from the site root (or inside `src/plugins/mysql-plugin`):

```bash
npm install mysql2
```

Restart afterwards, or sync from the `base` checkout, or upload the ZIP / npm name from the admin Plugins page. The admin menu entry "MySQL 插件" links to the settings page; the older path `/admin/plugins/mysql-plugin` redirects there.

## Switching to MySQL

Everything happens on the settings page at `/admin/plugins/mysql-plugin/settings`, guarded by the base `plugin:manage` permission:

1. Fill in host, port, user, password, and database name.
2. Press Test connection first. It only checks reachability and writes nothing.
3. Save and migrate. The action asks for confirmation, warns that the target tables are fully overwritten, then copies SQLite into MySQL.
4. Restart the site. Business data now lands in MySQL.

A few practical details: settings persist in `data/mysql-plugin.json` with chmod `0600`, because the password sits there in plain text, so keep the `data` directory out of version control. The database name is validated against `^[A-Za-z0-9_]+$` before it is ever interpolated into a statement. Leave the password field blank to keep the previously saved one. Disconnect deletes the config file; after a restart the site runs on SQLite again.

## How the takeover works

The plugin declares `preboot: true`, so the takeover starts before the site serves anything. In `preboot` it creates the connection pool, ensures the schema (utf8mb4, pool limit 5, tables mirroring base SQLite exactly: `sessions`, `groups`, `users`, `posts`, `comments`, plus the same indexes), and moves session storage to MySQL. In `bootstrap` it replaces every business service, `databaseService`, `auth`, `users`, `posts`, `comments`, `groups`, `permissions`, with dialect-correct MySQL implementations. In `activate` it registers the admin UI.

The replacements sit behind the same interfaces and every base hook keeps firing, so the rest of the plugin ecosystem keeps working. Plugins that store data through the database service, media-library's `media_library` table for example, follow MySQL automatically. The migration itself copies groups, then users, posts, comments, and sessions, inside one transaction, clearing the target rows first and reading only from SQLite, which stays untouched as the source of truth. The OOBE flow is untouched: without a config file no MySQL logic runs at all.

## FAQ

**Does migration destroy anything?** It clears the target MySQL tables first, then copies everything from SQLite. The SQLite side is never modified, so the original data is always intact.

**How do I go back to SQLite?** Press Disconnect on the settings page (this deletes the config file), then restart; the site runs on SQLite again with all its data.

**What if MySQL is unreachable or the schema fails to build?** Startup aborts; the plugin never silently falls back to SQLite. Fix the connection, or remove `data/mysql-plugin.json` and restart.

## License

GPL-3.0-or-later, Copyright (C) 2026 Evarentha. See LICENSE.
