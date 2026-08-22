/**
 * LinearPress MySQL driver — service layer.
 *
 * 与 base/src/core/core-services.ts 的服务契约完全对应，但所有数据访问
 * 都基于 mysql2/promise 连接池（`?` 占位符），不绑定任何 SQLite 查询。
 *
 * 导出的工厂：
 *   createDatabaseService(pool)        -> 与 DatabaseService 同构（raw 为连接池）
 *   createAuthService(pool, hooks)     -> AuthService
 *   createUserService(pool, hooks)     -> UserService
 *   createPostService(pool, hooks)     -> PostService（generateSlug / render 纯函数）
 *   createCommentService(pool, hooks)  -> CommentService
 *   createGroupService(pool, hooks)    -> GroupService
 *   createPermissionService(pool)      -> PermissionService
 *   createSessionStore(pool)           -> 兼容 express-session Store 的会话存储
 *
 * JSON 列（content_json / permissions）读取时自动解析，写入时序列化。
 * 事务通过 AsyncLocalStorage 把回调内的所有查询绑定到同一连接。
 */
import bcrypt from 'bcryptjs';
import session from 'express-session';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
// 实际部署路径：插件位于 base/src/plugins/mysql-plugin，本文件在插件 src/ 下，
// 因此到 base 的 src 目录为 ../../../（core / types）。
import type { HookSystem } from '../../../core/hook-system.js';
import type { Block, Comment, CommentStatus, Group, Post, PostStatus, User } from '../../../types/index.js';
import type { AuthService, CommentService, GroupService, PermissionService, PostService, UserService } from '../../../types/services.js';

export type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
export type { HookSystem } from '../../../core/hook-system.js';
export type { Block, Comment, CommentStatus, Group, Post, PostStatus, User } from '../../../types/index.js';
export type { AuthService, CommentService, DatabaseService, GroupService, PermissionService, PostService, SessionStoreFactory, UserService } from '../../../types/services.js';

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

/** MySQL run 语句的结果（对齐 base 的 SqliteRunResult 形状）。 */
export interface MySQLRunResult {
  lastInsertRowid: number;
  changes: number;
}

type AnyRow = Record<string, unknown>;

/** 把 mysql2 默认返回的 Date 转换成与 SQLite CURRENT_TIMESTAMP 一致的字面量。 */
function toMysqlDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 逐行规整：日期列 -> 字符串（dateStrings 未开启时 mysql2 返回 Date 对象）。 */
function normalizeRow(row: AnyRow): AnyRow {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Date) row[key] = toMysqlDateString(value);
  }
  return row;
}

/**
 * JSON 列解析：兼容 TEXT 列（返回字符串，需要 parse）与 MySQL 原生 JSON 列
 * （mysql2 已自动解析为对象，直接透传）。
 */
function parseJsonColumn<T>(value: unknown): T {
  if (value == null) return value as T;
  if (typeof value === 'object') return value as T;
  return JSON.parse(String(value)) as T;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/* ------------------------------------------------------------------ */
/* 查询帮助函数（含事务连接绑定）                                        */
/* ------------------------------------------------------------------ */

/** 事务上下文：transaction() 内所有查询自动切换到专用连接。 */
const transactionContext = new AsyncLocalStorage<PoolConnection>();

function getQueryable(pool: Pool): Pool | PoolConnection {
  return transactionContext.getStore() ?? pool;
}

async function queryAllRows<T>(queryable: Pool | PoolConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await queryable.query(sql, params) as unknown as [Array<AnyRow> | undefined, unknown];
  return (rows ?? []).map((row) => normalizeRow(row) as T);
}

async function queryRow<T>(queryable: Pool | PoolConnection, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await queryAllRows<T>(queryable, sql, params);
  return rows[0];
}

async function queryRun(queryable: Pool | PoolConnection, sql: string, params: unknown[] = []): Promise<MySQLRunResult> {
  const [result] = await queryable.query(sql, params) as unknown as [ResultSetHeader, unknown];
  return { lastInsertRowid: Number(result.insertId), changes: Number(result.affectedRows) };
}

/** 在独立连接上开启事务；回调内（经 AsyncLocalStorage）的所有查询共享该连接。 */
async function runTransaction<T>(pool: Pool, callback: () => T | Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await transactionContext.run(connection, callback);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

/* ------------------------------------------------------------------ */
/* 文章 slug 与渲染（纯函数，避免 SQLite 绑定）                          */
/* ------------------------------------------------------------------ */

/** 生成 URL slug（与 base/src/services/post.service.ts 的纯函数一致）。 */
export function generateSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!));

/** 内置块渲染兜底（当 base 的 block-registry 不可达时使用，行为与 base 一致）。 */
function localRenderBlocks(blocks: Block[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph': return `<p>${escapeHtml(block.content)}</p>`;
      case 'heading': return `<h${String(block.level)}>${escapeHtml(block.content)}</h${String(block.level)}>`;
      case 'blockquote': return `<blockquote>${escapeHtml(block.content)}</blockquote>`;
      case 'image': return `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? '')}"></figure>`;
      case 'custom-html': return String(block.content ?? '');
      default: return '';
    }
  }).join('\n');
}

/**
 * base block-registry 候选路径：
 * 1. 实际部署路径：base/src/plugins/mysql-plugin/src -> ../../../core/block-registry.js（= base/src/core）；
 * 2. 开发位置（仓库 Plugins/ 下）兜底：../../../base/src/core/block-registry.js（部署后该候选不可达，自动跳过）。
 */
const BLOCK_REGISTRY_CANDIDATES = [
  '../../../core/block-registry.js',
  '../../../base/src/core/block-registry.js'
];

/** 优先复用 base 的全局块注册表（含插件自定义块），不可达时退化为本地内置渲染。 */
async function loadRenderBlocks(): Promise<(blocks: Block[]) => string> {
  for (const spec of BLOCK_REGISTRY_CANDIDATES) {
    try {
      const mod = (await import(spec)) as { renderBlocks?: (blocks: Block[]) => string };
      if (typeof mod.renderBlocks === 'function') return mod.renderBlocks;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return localRenderBlocks;
}

/** 渲染 blocks -> HTML（等价 base 的 renderBlocks，仅复用纯函数，不触碰 SQLite）。 */
export const renderBlocks: (blocks: Block[]) => string = await loadRenderBlocks();

/* ------------------------------------------------------------------ */
/* 用户 / 认证实现                                                      */
/* ------------------------------------------------------------------ */

async function findUserById(pool: Pool, id: number): Promise<User | undefined> {
  return queryRow<User>(pool, 'SELECT * FROM users WHERE id = ?', [id]);
}

async function findUserByUsername(pool: Pool, username: string): Promise<User | undefined> {
  return queryRow<User>(pool, 'SELECT * FROM users WHERE username = ?', [username]);
}

async function isOobeRequired(pool: Pool): Promise<boolean> {
  const row = await queryRow<{ id: number }>(pool, 'SELECT id FROM users WHERE is_super_admin = 1 LIMIT 1');
  return !row;
}

async function authenticateUser(pool: Pool, username: string, password: string): Promise<User | undefined> {
  const user = await findUserByUsername(pool, username);
  return user && (await bcrypt.compare(password, user.password_hash)) ? user : undefined;
}

async function createSuperAdminUser(pool: Pool, username: string, email: string, password: string, confirmation: string): Promise<User> {
  if (!(await isOobeRequired(pool))) throw new Error('OOBE 已完成，不能再次创建超级管理员');
  if (username.trim().length < 3) throw new Error('用户名至少需要 3 个字符');
  if (!email.trim()) throw new Error('必须填写超级管理员邮箱');
  if (password.length < 8) throw new Error('密码至少需要 8 个字符');
  if (password !== confirmation) throw new Error('两次输入的密码不一致');
  const group = await queryRow<{ id: number }>(pool, "SELECT id FROM groups WHERE name = 'admin' LIMIT 1");
  if (!group) throw new Error('管理员权限组不存在');
  const hash = await bcrypt.hash(password, 12);
  return runTransaction(pool, async () => {
    if (!(await isOobeRequired(pool))) throw new Error('超级管理员已由其他请求创建');
    const { lastInsertRowid } = await queryRun(pool, 'INSERT INTO users(username,password_hash,email,group_id,is_super_admin) VALUES(?,?,?,?,1)', [username.trim(), hash, email.trim(), group.id]);
    return (await findUserById(pool, lastInsertRowid))!;
  });
}

async function registerUser(pool: Pool, username: string, email: string | null, password: string): Promise<User> {
  if (username.trim().length < 3 || password.length < 8) throw new Error('用户名至少 3 个字符，密码至少 8 个字符');
  const group = await queryRow<{ id: number }>(pool, "SELECT id FROM groups WHERE name = 'subscriber' LIMIT 1");
  if (!group) throw new Error('默认权限组不存在');
  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = await queryRun(pool, 'INSERT INTO users(username,password_hash,email,group_id) VALUES(?,?,?,?)', [username.trim(), hash, email || null, group.id]);
  return (await findUserById(pool, lastInsertRowid))!;
}

interface GroupRow extends Omit<Group, 'permissions'> { permissions: unknown; }

function hydrateGroup(row: GroupRow | undefined): Group | undefined {
  return row ? { ...row, permissions: parseJsonColumn<string[]>(row.permissions) } : undefined;
}

async function getGroup(pool: Pool, id: number): Promise<Group | undefined> {
  return hydrateGroup(await queryRow<GroupRow>(pool, 'SELECT * FROM groups WHERE id = ?', [id]));
}

async function listUsers(pool: Pool): Promise<Array<User & { group_name: string }>> {
  return queryAllRows<User & { group_name: string }>(
    pool,
    'SELECT users.*, groups.name AS group_name FROM users JOIN groups ON groups.id = users.group_id ORDER BY users.created_at DESC'
  );
}

async function listGroups(pool: Pool): Promise<Group[]> {
  const rows = await queryAllRows<GroupRow>(pool, 'SELECT * FROM groups ORDER BY id');
  return rows.map((row) => hydrateGroup(row)!);
}

async function assignUserGroup(pool: Pool, userId: number, groupId: number): Promise<void> {
  const user = await findUserById(pool, userId);
  const group = await getGroup(pool, groupId);
  if (!user || !group) throw new Error('用户或权限组不存在');
  if (user.is_super_admin) throw new Error('不能修改超级管理员的权限组');
  if (group.permissions.includes('*')) throw new Error('内置管理员组仅供唯一超级管理员使用');
  await queryRun(pool, 'UPDATE users SET group_id = ? WHERE id = ?', [groupId, userId]);
}

/* ------------------------------------------------------------------ */
/* 文章实现                                                            */
/* ------------------------------------------------------------------ */

interface PostRow extends Omit<Post, 'content_json'> { content_json: unknown; }

function hydratePost(row: PostRow | undefined): Post | undefined {
  return row ? { ...row, content_json: parseJsonColumn<Block[]>(row.content_json) } : undefined;
}

async function findPostById(pool: Pool, id: number): Promise<Post | undefined> {
  return hydratePost(await queryRow<PostRow>(pool, 'SELECT * FROM posts WHERE id = ?', [id]));
}

async function findPostBySlug(pool: Pool, slug: string): Promise<Post | undefined> {
  return hydratePost(await queryRow<PostRow>(pool, 'SELECT * FROM posts WHERE slug = ?', [slug]));
}

async function listAllPosts(pool: Pool): Promise<Array<Post & { author_name: string }>> {
  const rows = await queryAllRows<PostRow & { author_name: string }>(
    pool,
    'SELECT posts.*, users.username AS author_name FROM posts JOIN users ON users.id = posts.author_id ORDER BY posts.created_at DESC'
  );
  return rows.map((row) => ({ ...hydratePost(row)!, author_name: row.author_name }));
}

async function listPublishedPosts(pool: Pool, limit = 20, offset = 0): Promise<Post[]> {
  const rows = await queryAllRows<PostRow>(pool, "SELECT * FROM posts WHERE status = 'published' ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  return rows.map((row) => hydratePost(row)!);
}

async function uniquePostSlug(pool: Pool, value: string, title: string, postId?: number): Promise<string> {
  const base = generateSlug(value) || generateSlug(title) || 'post';
  let candidate = base;
  let suffix = 2;
  while (await queryRow<{ id: number }>(pool, 'SELECT id FROM posts WHERE slug = ? AND id <> ? LIMIT 1', [candidate, postId ?? 0])) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

async function savePost(pool: Pool, input: { id?: number; title: string; slug: string; blocks: Block[]; status: PostStatus; authorId: number }): Promise<Post> {
  const title = input.title.trim();
  if (!title) throw new Error('文章标题不能为空');
  const slug = await uniquePostSlug(pool, input.slug, title, input.id);
  const html = renderBlocks(input.blocks);
  const json = JSON.stringify(input.blocks);
  let id = input.id;
  if (id) {
    await queryRun(pool, 'UPDATE posts SET title = ?, slug = ?, content_json = ?, html_cache = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, slug, json, html, input.status, id]);
  } else {
    const { lastInsertRowid } = await queryRun(pool, 'INSERT INTO posts(title,slug,content_json,html_cache,status,author_id) VALUES(?,?,?,?,?,?)', [title, slug, json, html, input.status, input.authorId]);
    id = lastInsertRowid;
  }
  return (await findPostById(pool, id))!;
}

async function deletePost(pool: Pool, id: number): Promise<void> {
  await queryRun(pool, 'DELETE FROM posts WHERE id = ?', [id]);
}

async function incrementViews(pool: Pool, id: number): Promise<void> {
  await queryRun(pool, 'UPDATE posts SET views = views + 1 WHERE id = ?', [id]);
}

/* ------------------------------------------------------------------ */
/* 评论实现                                                            */
/* ------------------------------------------------------------------ */

async function approvedCommentsForPost(pool: Pool, postId: number): Promise<Comment[]> {
  return queryAllRows<Comment>(pool, "SELECT * FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC", [postId]);
}

async function listComments(pool: Pool): Promise<Array<Comment & { post_title: string; username: string | null }>> {
  return queryAllRows<Comment & { post_title: string; username: string | null }>(
    pool,
    'SELECT comments.*, posts.title AS post_title, users.username FROM comments JOIN posts ON posts.id = comments.post_id LEFT JOIN users ON users.id = comments.user_id ORDER BY comments.created_at DESC'
  );
}

async function findComment(pool: Pool, id: number): Promise<Comment | undefined> {
  return queryRow<Comment>(pool, 'SELECT * FROM comments WHERE id = ?', [id]);
}

async function createComment(pool: Pool, input: { postId: number; userId?: number; guestName?: string; guestEmail?: string; content: string; ip?: string }): Promise<Comment> {
  if (input.content.trim().length < 2) throw new Error('评论内容过短');
  const { lastInsertRowid } = await queryRun(
    pool,
    'INSERT INTO comments(post_id,user_id,guest_name,guest_email,content,ip) VALUES(?,?,?,?,?,?)',
    [input.postId, input.userId ?? null, input.guestName ?? null, input.guestEmail ?? null, input.content.trim(), input.ip ?? null]
  );
  return (await findComment(pool, lastInsertRowid))!;
}

async function setCommentStatus(pool: Pool, id: number, status: CommentStatus): Promise<void> {
  await queryRun(pool, 'UPDATE comments SET status = ? WHERE id = ?', [status, id]);
}

async function deleteComment(pool: Pool, id: number): Promise<void> {
  await queryRun(pool, 'DELETE FROM comments WHERE id = ?', [id]);
}

/* ------------------------------------------------------------------ */
/* 权限组 / 权限注册表（与 base 的 group.service.ts 内存注册表一致）      */
/* ------------------------------------------------------------------ */

const permissionRegistry = new Map<string, string>([
  ['admin:access', '访问后台'],
  ['post:create', '创建文章'],
  ['post:edit', '编辑文章'],
  ['post:delete', '删除文章'],
  ['comment:create', '创建评论'],
  ['comment:moderate', '审核评论'],
  ['user:manage', '管理用户'],
  ['group:manage', '管理权限组'],
  ['plugin:manage', '管理插件']
]);

function registerPermission(id: string, label = id): void {
  if (!id.trim() || id === '*') throw new Error('权限标识无效');
  permissionRegistry.set(id, label);
}

function listPermissionDefinitions(): Array<{ id: string; label: string }> {
  return [...permissionRegistry].map(([id, label]) => ({ id, label }));
}

async function createGroup(pool: Pool, name: string, permissions: string[]): Promise<Group> {
  const cleanName = name.trim();
  if (cleanName.length < 2) throw new Error('权限组名称至少需要 2 个字符');
  const valid = permissions.filter((permission) => permissionRegistry.has(permission));
  const { lastInsertRowid } = await queryRun(pool, 'INSERT INTO groups(name,permissions,is_system) VALUES(?,?,0)', [cleanName, JSON.stringify(valid)]);
  return (await getGroup(pool, lastInsertRowid))!;
}

async function updateGroup(pool: Pool, id: number, name: string, permissions: string[]): Promise<Group> {
  const group = await getGroup(pool, id);
  if (!group) throw new Error('权限组不存在');
  if (group.is_system) throw new Error('系统权限组不可修改');
  const valid = permissions.filter((permission) => permissionRegistry.has(permission));
  await queryRun(pool, 'UPDATE groups SET name = ?, permissions = ? WHERE id = ?', [name.trim(), JSON.stringify(valid), id]);
  return (await getGroup(pool, id))!;
}

async function deleteGroup(pool: Pool, id: number): Promise<void> {
  const group = await getGroup(pool, id);
  if (!group) throw new Error('权限组不存在');
  if (group.is_system) throw new Error('系统权限组不可删除');
  const fallback = await queryRow<{ id: number }>(pool, "SELECT id FROM groups WHERE name = 'subscriber' LIMIT 1");
  if (!fallback) throw new Error('默认权限组不存在');
  await queryRun(pool, 'UPDATE users SET group_id = ? WHERE group_id = ?', [fallback.id, id]);
  await queryRun(pool, 'DELETE FROM groups WHERE id = ?', [id]);
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

/** 与 base DatabaseService 契约同构，但 raw 为 mysql2 连接池（入口替换 TOKENS.databaseService 时需断言）。 */
export interface MySQLDatabaseService {
  raw: Pool;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<MySQLRunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(callback: () => T | Promise<T>): Promise<T>;
}

export function createDatabaseService(pool: Pool): MySQLDatabaseService {
  return {
    raw: pool,
    all: <T>(sql: string, ...params: unknown[]) => queryAllRows<T>(pool, sql, params),
    get: <T>(sql: string, ...params: unknown[]) => queryRow<T>(pool, sql, params),
    run: (sql, ...params) => queryRun(pool, sql, params),
    exec: async (sql) => {
      // 多语句 DDL 需要连接池开启 multipleStatements: true
      await getQueryable(pool).query(sql);
    },
    transaction: <T>(callback: () => T | Promise<T>) => runTransaction(pool, callback)
  };
}

export function createAuthService(pool: Pool, hooks: HookSystem): AuthService {
  return {
    isOobeRequired: () => isOobeRequired(pool),
    authenticate: async (username, password) => {
      const draft = await hooks.trigger('auth:beforeLogin', { username, password });
      const user = await authenticateUser(pool, draft.username, draft.password);
      return user ? hooks.trigger('auth:afterLogin', user) : undefined;
    },
    createSuperAdmin: async (username, email, password, confirmation) => {
      if (password !== confirmation) throw new Error('两次输入的密码不一致');
      const draft = await hooks.trigger('user:beforeCreate', { username, email, password, isSuperAdmin: true });
      const user = await createSuperAdminUser(pool, draft.username, draft.email ?? '', draft.password, draft.password);
      return hooks.trigger('user:afterCreate', user);
    }
  };
}

export function createUserService(pool: Pool, hooks: HookSystem): UserService {
  return {
    findById: (id) => findUserById(pool, id),
    findByUsername: (username) => findUserByUsername(pool, username),
    list: () => listUsers(pool),
    register: async (username, email, password) => {
      const draft = await hooks.trigger('user:beforeCreate', { username, email, password, isSuperAdmin: false });
      const user = await registerUser(pool, draft.username, draft.email, draft.password);
      return hooks.trigger('user:afterCreate', user);
    },
    assignGroup: async (userId, groupId) => {
      const user = await findUserById(pool, userId);
      const group = await getGroup(pool, groupId);
      if (!user || !group) throw new Error('用户或权限组不存在');
      const payload = await hooks.trigger('user:beforeAssignGroup', { user, group });
      await assignUserGroup(pool, payload.user.id, payload.group.id);
      await hooks.trigger('user:afterAssignGroup', payload);
    },
    listGroups: () => listGroups(pool),
    getGroup: (id) => getGroup(pool, id)
  };
}

export function createPostService(pool: Pool, hooks: HookSystem): PostService {
  return {
    findById: (id) => findPostById(pool, id),
    findBySlug: (slug) => findPostBySlug(pool, slug),
    list: () => listAllPosts(pool),
    listPublished: (limit, offset) => listPublishedPosts(pool, limit, offset),
    save: async (input) => {
      const existing = input.id ? await findPostById(pool, input.id) : undefined;
      const draft = await hooks.trigger('post:beforeSave', {
        id: input.id ?? 0,
        title: input.title,
        slug: input.slug ?? '',
        content_json: input.blocks,
        html_cache: existing?.html_cache ?? null,
        status: input.status,
        author_id: input.authorId,
        views: existing?.views ?? 0,
        created_at: existing?.created_at ?? '',
        updated_at: existing?.updated_at ?? null
      });
      const saved = await savePost(pool, { id: draft.id || undefined, title: draft.title, slug: draft.slug, blocks: draft.content_json, status: draft.status, authorId: draft.author_id });
      return hooks.trigger('post:afterSave', saved);
    },
    remove: async (id) => {
      const post = await findPostById(pool, id);
      if (!post) throw new Error('文章不存在');
      const payload = await hooks.trigger('post:beforeDelete', { post });
      await deletePost(pool, payload.post.id);
      await hooks.trigger('post:afterDelete', payload);
    },
    incrementViews: (id) => incrementViews(pool, id),
    generateSlug,
    render: renderBlocks
  };
}

export function createCommentService(pool: Pool, hooks: HookSystem): CommentService {
  return {
    listForPost: (postId) => approvedCommentsForPost(pool, postId),
    list: () => listComments(pool),
    find: (id) => findComment(pool, id),
    create: async (input) => {
      const draft = await hooks.trigger('comment:beforeCreate', input);
      const comment = await createComment(pool, draft);
      return hooks.trigger('comment:afterCreate', comment);
    },
    setStatus: async (id, status) => {
      const comment = await findComment(pool, id);
      if (!comment) throw new Error('评论不存在');
      const payload = await hooks.trigger('comment:beforeModerate', { comment, status });
      await setCommentStatus(pool, payload.comment.id, payload.status);
    },
    remove: async (id) => {
      const comment = await findComment(pool, id);
      if (!comment) throw new Error('评论不存在');
      const payload = await hooks.trigger('comment:beforeDelete', { comment });
      await deleteComment(pool, payload.comment.id);
      await hooks.trigger('comment:afterDelete', payload);
    }
  };
}

export function createGroupService(pool: Pool, hooks: HookSystem): GroupService {
  return {
    find: (id) => getGroup(pool, id),
    list: () => listGroups(pool),
    permissions: () => listPermissionDefinitions().map((item) => item.id),
    create: async (name, permissions) => {
      const draft = await hooks.trigger('group:beforeSave', { name, permissions });
      return createGroup(pool, draft.name, draft.permissions);
    },
    update: async (id, name, permissions) => {
      const draft = await hooks.trigger('group:beforeSave', { id, name, permissions });
      return updateGroup(pool, draft.id!, draft.name, draft.permissions);
    },
    remove: async (id) => {
      const group = await getGroup(pool, id);
      if (!group) throw new Error('权限组不存在');
      const payload = await hooks.trigger('group:beforeDelete', { group });
      await deleteGroup(pool, payload.group.id);
    }
  };
}

export function createPermissionService(pool: Pool): PermissionService {
  return {
    has: async (userId, permission) => {
      const user = await findUserById(pool, userId);
      if (user?.is_super_admin) return true;
      const group = user ? await getGroup(pool, user.group_id) : undefined;
      return Boolean(group && (group.permissions.includes('*') || group.permissions.includes(permission)));
    },
    register: (permission, label) => registerPermission(permission, label),
    list: listPermissionDefinitions
  };
}

/* ------------------------------------------------------------------ */
/* express-session 会话存储（兼容 Store 的 get/set/destroy/touch）       */
/* ------------------------------------------------------------------ */

type SessionCallback = (error?: Error | null, value?: session.SessionData | null) => void;
type VoidCallback = (error?: Error | null) => void;

/** MySQL 会话存储：sessions(sid 主键, sess JSON, expired 过期时间戳) 表。 */
export class MySQLSessionStore extends session.Store {
  constructor(private pool: Pool) { super(); }

  get(sid: string, callback: SessionCallback): void {
    this.pool.query('SELECT sess, expired FROM sessions WHERE sid = ?', [sid])
      .then(([rows]) => {
        const row = (rows as Array<{ sess: string; expired: number }>)[0];
        if (!row || row.expired <= Date.now()) return callback(null, null);
        callback(null, JSON.parse(row.sess) as session.SessionData);
      })
      .catch((error: unknown) => callback(toError(error)));
  }

  set(sid: string, sess: session.SessionData, callback: VoidCallback): void {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86_400_000;
    this.pool.query(
      'INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON DUPLICATE KEY UPDATE sess = VALUES(sess), expired = VALUES(expired)',
      [sid, JSON.stringify(sess), expires]
    ).then(() => callback(null)).catch((error: unknown) => callback(toError(error)));
  }

  destroy(sid: string, callback: VoidCallback): void {
    this.pool.query('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch((error: unknown) => callback(toError(error)));
  }

  touch(sid: string, sess: session.SessionData, callback: VoidCallback): void {
    this.set(sid, sess, callback);
  }
}

/** 创建兼容 express-session 的 Store（替换 TOKENS.sessionStoreFactory 时可直接使用）。 */
export function createSessionStore(pool: Pool): session.Store {
  return new MySQLSessionStore(pool);
}