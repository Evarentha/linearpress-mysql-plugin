/*
 * MySQL Connection Configuration Store
 *
 * Reads, writes, and validates the MySQL connection config persisted as JSON.
 *
 * Authors:
 * MoyuZJ <moyuzj@moyuzj.cn> @LinearTeam - Made in China with ♥
 * worryzu <worryzu@gmail.com> @LinearTeam
 *
 * Copyright (C) 2026 Evarentha
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Connection configuration for the MySQL plugin, persisted at data/mysql-plugin.json so it does
 * not depend on the infrastructure SQLite that is not yet initialized during preboot.
 *
 * <p>Database names are restricted to letters, digits, and underscores so they can be safely
 * interpolated into backquoted identifiers; the config file is chmod 0o600 because it holds
 * the database password in plain text.</p>
 *
 * @since 1.1.0
 */

import fs from 'fs-extra';
import path from 'node:path';

/** 插件连接配置（持久化在 data/mysql-plugin.json，避免依赖尚未初始化的基础设施 SQLite）。 */
export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 最近一次成功迁移的时间（ISO 8601），由 /migrate 成功后写入。 */
  migratedAt?: string;
}

const CONFIG_PATH = path.join(process.cwd(), 'data', 'mysql-plugin.json');

/** MySQL 数据库名只允许字母、数字、下划线（用于安全拼接反引号标识符）。 */
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** 校验数据库名，非法时抛错；返回原值以便链式使用（统一在配置写入与建库前调用）。 */
export function assertValidDatabaseName(database: string): string {
  if (!DATABASE_NAME_PATTERN.test(database)) {
    throw new Error('MySQL 数据库名只能包含字母、数字和下划线');
  }
  return database;
}

export function readConfig(): MysqlConfig | undefined {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return undefined;
    return fs.readJsonSync(CONFIG_PATH) as MysqlConfig;
  } catch {
    return undefined;
  }
}

export function writeConfig(config: MysqlConfig): void {
  assertValidDatabaseName(config.database);
  fs.ensureDirSync(path.dirname(CONFIG_PATH));
  // Atomic publish: failed writes must not leave an enabled, half-written configuration.
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, CONFIG_PATH);
  } finally { fs.removeSync(temporary); }
}

export function clearConfig(): void {
  fs.removeSync(CONFIG_PATH);
}

export function hasConfig(): boolean {
  return readConfig() !== undefined;
}
