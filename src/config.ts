/*
 * Author: MoyuZJ
 * Team: LinearTeam
 * Contact: linearteam@foxmail.com
 * Made by MoyuZJ in China with ♥
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
  fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 });
  // 配置含数据库明文密码，仅允许属主读写，防止备份/共享时泄露。
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export function clearConfig(): void {
  fs.removeSync(CONFIG_PATH);
}

export function hasConfig(): boolean {
  return readConfig() !== undefined;
}
