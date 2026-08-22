/*
 * Author: MoyuZJ
 * Team: LinearTeam
 * Contact: linearteam@foxmail.com
 * Made by MoyuZJ in China with ♥
 */

import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
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
     KEY idx_comments_post_status (post_id, status)
   )`
];

/** 创建连接池（multipleStatements 支持迁移阶段的批量 DDL）。 */
export function createPool(config: MysqlConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: true,
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
    multipleStatements: true,
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
    await pool.query(statement);
  }
}

/**
 * 将 SQLite 内的数据全量迁移到 MySQL（空目标库）。
 * 复制顺序：groups -> users -> posts -> comments -> sessions。
 * 直接读取基础设施 SQLite 单例（此时插件仍在 SQLite 阶段）。
 */
export async function migrateFromSqlite(pool: Pool): Promise<{ tables: string[] }> {
  const tables = ['groups', 'users', 'posts', 'comments', 'sessions'];
  const [gRows, uRows, pRows, cRows, sRows] = (['groups', 'users', 'posts', 'comments', 'sessions'] as const).map((t) =>
    sqlite.prepare(`SELECT * FROM ${t}`).all()
  );

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // 清空目标（迁移语义：以 SQLite 为准重建 MySQL 数据）
    for (const table of [...tables].reverse()) {
      await connection.query(`DELETE FROM ${table}`);
    }
    const insert = async (table: string, rows: Array<Record<string, unknown>>): Promise<void> => {
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.length) continue;
        const placeholders = columns.map(() => '?').join(', ');
        await connection.query(
          `INSERT INTO ${table}(${columns.join(', ')}) VALUES(${placeholders})`,
          columns.map((col) => row[col])
        );
      }
    };
    await insert('groups', gRows as Array<Record<string, unknown>>);
    await insert('users', uRows as Array<Record<string, unknown>>);
    await insert('posts', pRows as Array<Record<string, unknown>>);
    await insert('comments', cRows as Array<Record<string, unknown>>);
    await insert('sessions', sRows as Array<Record<string, unknown>>);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
  return { tables };
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
