/*
 * MySQL Driver Plugin Entry Point
 *
 * Cordis plugin that swaps LinearPress's SQLite services for MySQL-backed implementations.
 *
 * Authors:
 * MoyuZJ <moyuzj@moyuzj.cn> @LinearTeam - Made in China with ♥
 *
 * Copyright (C) 2026 Evarentha
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Entry point of the LinearPress MySQL driver plugin.
 *
 * <p>The deployment location is fixed at base/src/plugins/mysql-plugin/index.ts, so references
 * to base always use '../../core/...' / '../../types/...' (never '../../../../src/...').</p>
 *
 * Lifecycle (Cordis native phases):
 * <ul>
 * <li>preboot — when unconfigured, leave OOBE/SQLite untouched; when a config exists, first
 * ensure the schema (a failure aborts startup outright, avoiding a silent fallback to SQLite
 * that would fork the data), then replace sessionStoreFactory.</li>
 * <li>bootstrap — replace databaseService / auth / users / posts / comments / groups /
 * permissions.</li>
 * <li>activate — register the settings page / auto-migration / test-connection / clear-config
 * routes and the admin menu entry.</li>
 * <li>Effect — close the connection pool held by this process.</li>
 * </ul>
 *
 * @since 1.1.0
 */
import type { Context } from 'cordis';
import type { RequestHandler } from 'express';
import type { DatabaseService } from '../../types/services.js';
// 基础设施 SQLite（plugins 启停状态表）——仅用于读取 enabled 标志，业务数据仍走 MySQL。
import { db as infraDb } from '../../core/database.js';
import { replaceService } from '../../core/context.js';
import type { HookSystem } from '../../core/hook-system.js';
import type { Pool } from 'mysql2/promise';
import { assertValidDatabaseName, clearConfig, hasConfig, readConfig, writeConfig, type MysqlConfig } from './src/config.js';
import { createPool, ensureDatabase, ensureSchema, migrateFromSqlite, testConnection } from './src/mysql.js';
import {
  createAuthService,
  createCommentService,
  createDatabaseService,
  createGroupService,
  createPermissionService,
  createPostService,
  createSessionStore,
  createUserService
} from './src/services.js';

const PLUGIN_ID = 'mysql-plugin';
const PLUGIN_PATH = '/admin/plugins/mysql-plugin';
const SETTINGS_PATH = `${PLUGIN_PATH}/settings`;
const MANAGE_PERMISSION = 'plugin:manage';
const messageOf = (error: unknown): string => error instanceof Error ? error.message : '操作失败';

/** 本进程持有的连接池；只由 preboot/bootstrap 创建，Effect 关闭。 */
let activePool: Pool | undefined;

/** 配置存在且插件未被明确停用时才接管；首次启动尚无 plugins 表时按配置启用。 */
function isPluginEnabled(): boolean {
  if (!hasConfig()) return false;
  try {
    const row = infraDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get(PLUGIN_ID) as { enabled?: number } | undefined;
    return row?.enabled === undefined ? true : Boolean(row.enabled);
  } catch {
    // preboot 在首次迁移前执行，plugins 表可能尚不存在。
    return true;
  }
}

/** 密码留空时沿用已保存密码（设置页支持"留空保持不变"）。 */
function resolvePassword(body: Record<string, unknown>): string {
  const entered = String(body.password ?? '');
  return entered || readConfig()?.password || '';
}

export const preboot = async (context: Context): Promise<void> => {
  if (!isPluginEnabled()) return; // 未配置：不改动 OOBE/SQLite
  const config = readConfig()!;
  const pool = createPool(config);
  // 先确保 MySQL 表结构就绪，再切换会话存储。DDL 失败会向上抛出让启动失败，
  // 绝不静默退回 SQLite 阶段继续运行（否则会话/数据会分叉）。
  await ensureSchema(pool);
  activePool = pool;
  replaceService(context, 'sessionStoreFactory', () => createSessionStore(pool));
  context.effect(() => () => {
    if (activePool) {
      const pool = activePool;
      activePool = undefined;
      return pool.end().catch(() => undefined);
    }
  });
};

export const bootstrap = async (context: Context): Promise<void> => {
  if (!isPluginEnabled()) return;
  const config = readConfig()!;
  let pool = activePool;
  if (!pool) {
    // 防御：preboot 未创建时（不应发生）自行建池并确保表结构。
    pool = createPool(config);
    await ensureSchema(pool);
    activePool = pool;
  }
  // 替换业务服务；基础设施 SQLite 仅保留插件注册表等状态。
  // MySQLDatabaseService 与 DatabaseService 仅有 raw 类型差异，须经 unknown 断言。
  const hooks = context.hooks as HookSystem;
  const mysqlDatabase = createDatabaseService(pool) as unknown as DatabaseService;
  replaceService(context, 'databaseService', mysqlDatabase);
  replaceService(context, 'auth', createAuthService(pool, hooks));
  replaceService(context, 'users', createUserService(pool, hooks));
  replaceService(context, 'posts', createPostService(pool, hooks));
  replaceService(context, 'comments', createCommentService(pool, hooks));
  replaceService(context, 'groups', createGroupService(pool, hooks));
  replaceService(context, 'permissions', createPermissionService(pool));
};

export const activate = (context: Context): void => {
  const hooks = context.hooks as HookSystem;
  const web = context.web;
  // 后台菜单入口：与设置页主路径一致。
  hooks.on('admin:menu', (menu) => [...menu, { title: 'MySQL 插件', link: SETTINGS_PATH }]);

  /** 管理端守卫工厂（与 Base requireAuth/checkPermission 同构）：登录 + plugin:manage 权限。 */
  const checkManagePermission = (): RequestHandler => async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    // PermissionService.has 返回 MaybePromise，统一 await 处理。
    const allowed = await Promise.resolve(context.permissions.has(req.session.userId, MANAGE_PERMISSION)).catch(() => false);
    if (!allowed) return res.status(403).render('error', { title: '权限不足', message: '你没有管理插件的权限。' });
    next();
  };
  const requireManage = checkManagePermission();

  // 兼容旧入口：直接 302 到设置页主路径。
  web.register('get', PLUGIN_PATH, (_req, res) => res.redirect(302, SETTINGS_PATH));

  // 设置页（主路径）。
  web.register('get', SETTINGS_PATH, requireManage, (_req, res) => {
    const config = readConfig();
    res.render('mysql-plugin/settings', {
      title: 'MySQL 插件设置',
      configured: Boolean(config),
      host: config?.host ?? '',
      port: config?.port ?? 3306,
      user: config?.user ?? '',
      password: '',
      database: config?.database ?? '',
      migratedAt: config?.migratedAt ?? '',
      notice: (res.locals.notice as string) ?? (_req.query.notice as string) ?? ''
    });
  });

  // 测试连接（不建库）。
  web.register('post', `${PLUGIN_PATH}/test`, requireManage, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      await testConnection({
        host: String(body.host ?? '').trim(),
        port: Number(body.port) || 3306,
        user: String(body.user ?? '').trim(),
        password: resolvePassword(body),
        database: String(body.database ?? '').trim()
      });
      res.json({ ok: true, message: '连接成功' });
    } catch (error) {
      res.status(400).json({ ok: false, message: `连接失败：${messageOf(error)}` });
    }
  });

  // 保存配置并执行 SQLite -> MySQL 迁移。
  web.register('post', `${PLUGIN_PATH}/migrate`, requireManage, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const config: MysqlConfig = {
      host: String(body.host ?? '').trim(),
      port: Number(body.port) || 3306,
      user: String(body.user ?? '').trim(),
      password: resolvePassword(body),
      database: String(body.database ?? '').trim()
    };
    if (!config.host || !config.user || !config.database) {
      return res.status(400).json({ ok: false, message: '请填写主机、用户名和目标数据库名' });
    }
    try {
      // 数据库名进入反引号插值（CREATE DATABASE）前统一校验。
      assertValidDatabaseName(config.database);
      const pool = await ensureDatabase(config);
      try {
        await ensureSchema(pool);
        await migrateFromSqlite(pool);
        writeConfig({ ...config, migratedAt: new Date().toISOString() });
        res.json({ ok: true, message: '数据已迁移到 MySQL，重启站点后生效（MySQL 将替代 SQLite）。' });
      } finally {
        // 迁移用临时连接池无论成败都释放；唯一例外是本进程已在使用的 activePool。
        if (pool !== activePool) await pool.end().catch(() => undefined);
      }
    } catch (error) {
      res.status(400).json({ ok: false, message: `迁移失败：${messageOf(error)}` });
    }
  });

  // 清除配置（重启后恢复 SQLite；activePool 交由 Effect 在关闭时释放）。
  const clearHandler: RequestHandler = (_req, res) => {
    clearConfig();
    res.json({ ok: true, message: '已清除 MySQL 配置，重启站点后恢复使用 SQLite。' });
  };
  web.register('post', `${PLUGIN_PATH}/clear`, requireManage, clearHandler);
  // 兼容旧版设置页 UI 的断开入口（与 /clear 同义）。
  web.register('post', `${PLUGIN_PATH}/disconnect`, requireManage, clearHandler);
};
