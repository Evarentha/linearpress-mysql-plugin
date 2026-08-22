/*
 * Author: MoyuZJ
 * Team: LinearTeam
 * Contact: linearteam@foxmail.com
 * Made by MoyuZJ in China with ♥
 */

/**
 * LinearPress MySQL 驱动插件入口。
 *
 * 部署位置固定为 base/src/plugins/mysql-plugin/index.ts，因此对 base 的引用
 * 一律使用 '../../core/...' / '../../types/...'（不要 '../../../../src/...'）。
 *
 * 生命周期：
 *  - preboot   未配置时不干预 OOBE/SQLite；配置存在时先建表（失败直接中止启动，
 *              避免静默退回 SQLite 造成数据分叉），再替换 sessionStoreFactory。
 *  - bootstrap 替换 databaseService / auth / users / posts / comments / groups / permissions。
 *  - activate  注册设置页 /自动迁移 / 测试连接 / 清除配置路由与后台菜单。
 *  - deactivate 关闭本进程持有的连接池。
 */
import type { RequestHandler } from 'express';
import type { ActivateContext, PluginEntry, PrebootContext } from '../../types/plugin.js';
import type { DatabaseService } from '../../types/services.js';
// 基础设施 SQLite（plugins 启停状态表）——仅用于读取 enabled 标志，业务数据仍走 MySQL。
import { db as infraDb } from '../../core/database.js';
import { TOKENS } from '../../core/tokens.js';
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

/** 本进程持有的连接池；只由 preboot/bootstrap 创建，deactivate 时关闭。 */
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

export const preboot: PluginEntry['preboot'] = async ({ container }: PrebootContext) => {
  if (!isPluginEnabled()) return; // 未配置：不改动 OOBE/SQLite
  const config = readConfig()!;
  const pool = createPool(config);
  // 先确保 MySQL 表结构就绪，再切换会话存储。DDL 失败会向上抛出让启动失败，
  // 绝不静默退回 SQLite 阶段继续运行（否则会话/数据会分叉）。
  await ensureSchema(pool);
  activePool = pool;
  container.replace(TOKENS.sessionStoreFactory, () => createSessionStore(pool));
};

export const bootstrap: PluginEntry['bootstrap'] = async ({ container, hooks }: ActivateContext) => {
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
  const mysqlDatabase = createDatabaseService(pool) as unknown as DatabaseService;
  container.replace(TOKENS.databaseService, mysqlDatabase);
  container.replace(TOKENS.auth, createAuthService(pool, hooks));
  container.replace(TOKENS.users, createUserService(pool, hooks));
  container.replace(TOKENS.posts, createPostService(pool, hooks));
  container.replace(TOKENS.comments, createCommentService(pool, hooks));
  container.replace(TOKENS.groups, createGroupService(pool, hooks));
  container.replace(TOKENS.permissions, createPermissionService(pool));
};

export const activate: PluginEntry['activate'] = ({ router, hooks, container }: ActivateContext) => {
  // 后台菜单入口：与设置页主路径一致。
  hooks.on('admin:menu', (menu) => [...menu, { title: 'MySQL 插件', link: SETTINGS_PATH }]);

  /** 需要 plugin:manage 权限；PermissionService.has 返回 MaybePromise，统一 await 处理。 */
  const requireManage: RequestHandler = async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const allowed = await Promise.resolve(container.resolve(TOKENS.permissions).has(req.session.userId, MANAGE_PERMISSION)).catch(() => false);
    if (!allowed) return res.status(403).render('error', { title: '权限不足', message: '你没有管理插件的权限。' });
    next();
  };

  // 兼容旧入口：直接 302 到设置页主路径。
  router.register('get', PLUGIN_PATH, (_req, res) => res.redirect(302, SETTINGS_PATH));

  // 设置页（主路径）。
  router.register('get', SETTINGS_PATH, requireManage, (_req, res) => {
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
  router.register('post', `${PLUGIN_PATH}/test`, requireManage, async (req, res) => {
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
      res.status(400).json({ ok: false, message: `连接失败：${error instanceof Error ? error.message : String(error)}` });
    }
  });

  // 保存配置并执行 SQLite -> MySQL 迁移。
  router.register('post', `${PLUGIN_PATH}/migrate`, requireManage, async (req, res) => {
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
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, message: `迁移失败：${message}` });
    }
  });

  // 清除配置（重启后恢复 SQLite；activePool 交由 deactivate 在关闭时释放）。
  const clearHandler: RequestHandler = (_req, res) => {
    clearConfig();
    res.json({ ok: true, message: '已清除 MySQL 配置，重启站点后恢复使用 SQLite。' });
  };
  router.register('post', `${PLUGIN_PATH}/clear`, requireManage, clearHandler);
  // 兼容旧版设置页 UI 的断开入口（与 /clear 同义）。
  router.register('post', `${PLUGIN_PATH}/disconnect`, requireManage, clearHandler);
};

export const deactivate: PluginEntry['deactivate'] = async () => {
  if (activePool) {
    const pool = activePool;
    activePool = undefined;
    await pool.end().catch(() => undefined);
  }
};
