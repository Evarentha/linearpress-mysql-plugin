/*
 * MySQL Pool, Schema, and Migration Engine
 *
 * Creates MySQL pools, ensures the schema, and migrates all data from SQLite.
 *
 * Authors:
 * MoyuZJ <moyuzj@moyuzj.cn> @LinearTeam - Made in China with ♥
 * worryzu <worryzu@gmail.com> @LinearTeam
 *
 * Copyright (C) 2026 Evarentha
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * MySQL 8 schema/upgrade and non-destructive SQLite migration. All discovered business
 * tables are copied into an empty target; local infrastructure is explicitly excluded.
 * DDL is performed before the data transaction (MySQL DDL cannot be rolled back).
 * No target is cleared, and failed migration never publishes driver configuration.
 *
 * @since 1.1.0
 */

import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { compatibleQuery } from './sql-compat.js';
import { assertValidDatabaseName } from './config.js';
import type { MysqlConfig } from './config.js';
// 部署位置固定为 base/src/plugins/mysql-plugin/src/mysql.ts，SQLite 数据库模块相对路径为 ../../../core/database.js
import { db as sqlite } from '../../../core/database.js';

/** 主库表结构（MySQL 方言）。与 database.ts 的 SQLite 结构对应。 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
     sid VARCHAR(255) NOT NULL PRIMARY KEY,
     sess LONGTEXT NOT NULL,
     expired BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS groups (
     id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(190) NOT NULL UNIQUE,
     permissions LONGTEXT NOT NULL,
     is_system TINYINT DEFAULT 0,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id INT AUTO_INCREMENT PRIMARY KEY,
     username VARCHAR(190) NOT NULL UNIQUE,
     password_hash VARCHAR(255) NOT NULL,
     email VARCHAR(190) UNIQUE,
     group_id INT NOT NULL,
     CONSTRAINT lp_users_group FOREIGN KEY (group_id) REFERENCES groups(id),
     is_super_admin TINYINT NOT NULL DEFAULT 0,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS posts (
     id INT AUTO_INCREMENT PRIMARY KEY,
     title VARCHAR(500) NOT NULL,
     slug VARCHAR(500) NOT NULL UNIQUE,
     content_json LONGTEXT NOT NULL,
     html_cache LONGTEXT,
     status VARCHAR(20) NOT NULL DEFAULT 'draft',
     author_id INT NOT NULL,
     CONSTRAINT lp_posts_author FOREIGN KEY (author_id) REFERENCES users(id),
     views INT NOT NULL DEFAULT 0,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL,
     KEY idx_posts_status_created (status, created_at DESC)
   )`,
  `CREATE TABLE IF NOT EXISTS comments (
     id INT AUTO_INCREMENT PRIMARY KEY,
     post_id INT NOT NULL,
     user_id INT NULL,
     guest_name VARCHAR(190) NULL,
     guest_email VARCHAR(190) NULL,
     content LONGTEXT NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'pending',
     ip VARCHAR(64) NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     KEY idx_comments_post_status (post_id, status),
     CONSTRAINT lp_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
     CONSTRAINT lp_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
   )`
];

/** 创建连接池；禁用多语句，已知兼容层逐条执行 DDL。 */
export function createPool(config: MysqlConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: false,
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4'
  });
}

/** 仅连接（不指定库），用于创建目标数据库。 */
async function connectWithoutDatabase(config: MysqlConfig): Promise<Pool> {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false,
    charset: 'utf8mb4'
  });
  return pool;
}

/**
 * 创建数据库（若不存在），随后返回指向该库的正式连接池。数据库名在进入反引号插值前统一校验。
 * 内部"无库"临时连接池无论成功失败都会在 finally 中关闭，避免句柄泄漏。
 */
export async function ensureDatabase(config: MysqlConfig): Promise<Pool> {
  assertValidDatabaseName(config.database);
  const root = await connectWithoutDatabase(config);
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4`);
  } finally {
    await root.end().catch(() => undefined);
  }
  return createPool(config);
}

/** 在已指向目标库的 pool 上建表。 */
export async function ensureSchema(pool: Pool): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await compatibleQuery(pool, statement);
  }
  await upgradeForeignKeys(pool);
}

/** Upgrade old MySQL installations. Orphan comments are archived before cleanup, not lost.
 * DDL implicitly commits; archive creation precedes the cleanup transaction, FK DDL follows.
 * Invalid user/group or post/author links cause startup to fail rather than discard business data. */
export async function upgradeForeignKeys(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [links] = await connection.query(`SELECT k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name, k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
    const wanted = [
      ['users','group_id','groups','RESTRICT'], ['posts','author_id','users','RESTRICT'],
      ['comments','post_id','posts','CASCADE'], ['comments','user_id','users','SET NULL']
    ];
    const upgrades = wanted.filter(([table, col, , rule]) => !(links as any[]).some((r) => r.table_name === table && r.column_name === col && r.delete_rule === rule));
    if (!upgrades.length) return;
    await connection.query('CREATE TABLE IF NOT EXISTS _lp_orphan_comments LIKE comments');
    await connection.beginTransaction();
    try {
      // A retry must update its archive snapshot before cleanup (never IGNORE a stale backup).
      await connection.query('DELETE b FROM _lp_orphan_comments b JOIN comments c ON c.id=b.id LEFT JOIN posts p ON p.id=c.post_id LEFT JOIN users u ON u.id=c.user_id WHERE p.id IS NULL OR (c.user_id IS NOT NULL AND u.id IS NULL)');
      await connection.query('INSERT INTO _lp_orphan_comments SELECT c.* FROM comments c LEFT JOIN posts p ON p.id=c.post_id LEFT JOIN users u ON u.id=c.user_id WHERE p.id IS NULL OR (c.user_id IS NOT NULL AND u.id IS NULL)');
      await connection.query('DELETE c FROM comments c LEFT JOIN posts p ON p.id=c.post_id WHERE p.id IS NULL');
      await connection.query('UPDATE comments c LEFT JOIN users u ON u.id=c.user_id SET c.user_id=NULL WHERE c.user_id IS NOT NULL AND u.id IS NULL');
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    for (const [table, col, parent, rule] of upgrades) {
      const changes = (links as any[]).filter((r) => r.table_name === table && r.column_name === col).map((r) => `DROP FOREIGN KEY ${quote(r.name)}`);
      changes.push(`ADD CONSTRAINT ${quote('lp_' + table + '_' + col)} FOREIGN KEY (${quote(col)}) REFERENCES ${quote(parent)}(id) ON DELETE ${rule}`);
      // One atomic MySQL 8 ALTER: failed validation retains the old constraint.
      await connection.query(`ALTER TABLE ${quote(table)} ${changes.join(', ')}`);
    }
  } finally { connection.release(); }
}

/**
 * 将 SQLite 内的数据全量迁移到 MySQL（空目标库）。
 * 复制顺序：groups -> users -> posts -> comments -> sessions。
 * 直接读取基础设施 SQLite 单例（此时插件仍在 SQLite 阶段）。
 */
export const LOCAL_INFRA_TABLES = new Set(['plugins', 'settings', 'ifwp_media_map', 'plugin_install_ownership']);
const quote = (s: string): string => '\x60' + s.replace(/\x60/g, '\x60\x60') + '\x60';

/** Only empty targets are accepted. DDL is a separate, non-rollbackable phase; data copy
 * is one transaction. Failure can leave empty schema, never enables MySQL/configures migratedAt.
 * Local plugin registry/settings and the local attachment download cache remain in SQLite. */
export async function assertEmptyTarget(connection: any): Promise<void> {
  const [tables] = await connection.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'");
  for (const { name } of tables as Array<{name: string}>) {
    if (LOCAL_INFRA_TABLES.has(name)) continue;
    const [rows] = await connection.query(`SELECT 1 FROM ${quote(name)} LIMIT 1 FOR UPDATE`);
    if (rows.length) throw new Error(`目标业务数据库非空：${name}；拒绝覆盖迁移`);
  }
}
export async function migrateFromSqlite(pool: Pool, source = sqlite): Promise<{ tables: string[] }> {
  const schema = source.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name").all() as Array<{name: string; sql: string}>;
  const remaining = schema.filter((t) => !LOCAL_INFRA_TABLES.has(t.name));
  const ordered: typeof schema = [];
  while (remaining.length) {
    const next = remaining.findIndex((t) => {
      const refs = source.prepare(`PRAGMA foreign_key_list(${quote(t.name)})`).all() as Array<{table: string}>;
      return refs.every((r) => r.table === t.name || !remaining.some((x) => x.name === r.table));
    });
    if (next < 0) throw new Error('业务表存在循环外键，必须先提供显式迁移计划');
    ordered.push(...remaining.splice(next, 1));
  }
  // Snapshot all rows synchronously, before any asynchronous target I/O.
  const snapshot = ordered.map((t) => ({...t, rows: source.prepare(`SELECT * FROM ${quote(t.name)}`).all() as Array<Record<string, unknown>>}));
  const indexes = source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as Array<{sql: string}>;
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(CONCAT('lp_migrate_', DATABASE()), 0) AS acquired");
    if (Number((locks as any)[0]?.acquired) !== 1) throw new Error('另一个迁移正在执行');
    locked = true;
    await assertEmptyTarget(connection); // BEFORE any DDL or delete
    await ensureSchema(pool);
    for (const t of snapshot) await compatibleQuery(connection, t.sql.replace(/^CREATE TABLE(?: IF NOT EXISTS)?/i, 'CREATE TABLE IF NOT EXISTS'));
    for (const index of indexes) {
      // Core indexes already have their MySQL definitions; infrastructure indexes stay local.
      const table = index.sql.match(/\bON\s+["\x60]?([\w]+)/i)?.[1];
      if (!table || !snapshot.some((t) => t.name === table) || ['users','posts','comments'].includes(table)) continue;
      await compatibleQuery(connection, index.sql.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+/i, 'CREATE $1INDEX IF NOT EXISTS '));
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    await assertEmptyTarget(connection);
    for (const {name, rows} of snapshot) {
      for (const row of rows) {
        const columns = Object.keys(row);
        await compatibleQuery(connection, `INSERT INTO ${quote(name)}(${columns.map(quote).join(',')}) VALUES(${columns.map(() => '?').join(',')})`, columns.map((c) => row[c]));
      }
    }
    await connection.commit();
    return { tables: snapshot.map((t) => t.name) };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('lp_migrate_', DATABASE()))").catch(() => undefined);
    connection.release();
  }
}

/** 测试到指定 MySQL 实例的连接（不创建库）。 */
export async function testConnection(config: MysqlConfig): Promise<void> {
  const pool = await connectWithoutDatabase(config);
  try {
    await pool.query('SELECT 1');
  } finally {
    await pool.end().catch(() => undefined);
  }
}
