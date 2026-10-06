/*
 * LinearPress Sql Compat
 *
 * Implements the sql compat module for LinearPress.
 *
 * Authors:
 * MoyuZJ <moyuzj@moyuzj.cn> @LinearTeam - Made in China with ♥
 * worryzu <worryzu@gmail.com> @LinearTeam
 *
 * Copyright (C) 2026 Evarentha
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Known LinearPress SQLite SQL -> MySQL 8 compatibility. Literals/comments are never rewritten.
 * Unknown SQL is sent to MySQL (errors are not swallowed). DDL implicitly commits on MySQL;
 * callers must not issue DDL within a business transaction. */
export function protectSql(sql: string): { code: string; restore: (s: string) => string; literals: string[] } {
  const literals: string[] = [];
  const code = sql.replace(/\b__LP_LITERAL_\d+__\b|'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (s) => {
    const i = literals.push(s) - 1;
    return `__LP_LITERAL_${i}__`;
  });
  return { code, literals, restore: (s) => s.replace(/__LP_LITERAL_(\d+)__/g, (_, i) => literals[Number(i)]) };
}
export function splitSql(sql: string): string[] {
  const p = protectSql(sql);
  return p.code.split(';').map((s) => p.restore(s.trim())).filter(Boolean);
}
export function mysqlSql(sql: string): string {
  const p = protectSql(sql.trim().replace(/;\s*$/, ''));
  let s = p.code;
  s = s.replace(/\b(\w+)\s+INTEGER\b/gi, (_, col: string) => `${col} ${/^(id|.*_id)$/.test(col) ? 'INT' : 'BIGINT'}`).replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  // Match types only after a column name. Indexed identifiers are bounded; payloads retain LONGTEXT.
  s = s.replace(/\b([a-z_][\w]*)\s+TEXT\b/gi, (_, col: string) => {
    const widths: Record<string, number> = { id: 768, sid: 255, key: 190, scope: 255, name: 255, slug: 500, route: 200, kind: 32, status: 32, ip: 64, provider: 64, sub: 255, username: 190, email: 255, day: 32, wp_url: 768, source_key: 64, album_id: 768, created_at: 40, updated_at: 40, publish_at: 40 };
    const width = widths[col.toLowerCase()];
    return `${col} ${width ? `VARCHAR(${width})` : 'LONGTEXT'}`;
  });
  // SQLite stores date strings verbatim. Preserve ISO dates and local datetime strings;
  // DATE_FORMAT/date arithmetic still parse these values without changing ordinary parameters.
  s = s.replace(/\b(DATETIME|TIMESTAMP)\b(?!\s*\()/gi, 'VARCHAR(40)');
  s = s.replace(/(VARCHAR\(40\)\s+(?:NOT\s+NULL\s+)?DEFAULT)\s+CURRENT_TIMESTAMP/gi, '$1 (CURRENT_TIMESTAMP)');
  // MySQL TEXT defaults require expressions (8.0.13+).
  s = s.replace(/(LONGTEXT\s+(?:NOT\s+NULL\s+)?DEFAULT)\s+(__LP_LITERAL_\d+__|CURRENT_TIMESTAMP)/gi, '$1 ($2)');
  const ignoreConflict = /\bINSERT\s+OR\s+IGNORE\b/i.test(s) || /\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING\b/i.test(s);
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
  // REPLACE deletes rows in both SQLite/MySQL. Prefer UPSERT to preserve foreign-key children.
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(s)) {
    s = s.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT');
    const columns = s.match(/INSERT\s+INTO\s+(?:\w+|__LP_LITERAL_\d+__)\s*\(([^)]+)\)/i)?.[1].split(',').map((v) => v.trim());
    if (!columns) throw new Error('Unsupported INSERT OR REPLACE shape');
    s += ` ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c}=VALUES(${c})`).join(', ')}`;
  }
  s = s.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\b/gi, 'ON DUPLICATE KEY UPDATE');
  s = s.replace(/\bexcluded\.([\w]+)/gi, 'VALUES($1)');
  if (ignoreConflict) {
    s = s.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING\b/gi, '');
    const target = s.match(/\bINSERT\s+INTO\s+(\w+)\s*\(\s*(\w+)/i);
    if (!target) throw new Error('Unsupported conflict-ignore INSERT shape');
    // Unlike MySQL INSERT IGNORE this does not silently truncate or suppress FK/type errors.
    s += ` ON DUPLICATE KEY UPDATE ${target[2]}=${target[1]}.${target[2]}`;
  }
  s = s.replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE utf8mb4_unicode_ci');
  // SQLite accepts COLLATE after UNIQUE; MySQL column collation precedes constraints.
  s = s.replace(/(NOT\s+NULL\s+)?UNIQUE\s+(COLLATE\s+utf8mb4_unicode_ci)/gi, '$2 $1UNIQUE');
  s = s.replace(/\bgroup_concat\s*\(\s*([\w.]+)\s*,\s*(__LP_LITERAL_\d+__)\s*\)/gi, 'GROUP_CONCAT($1 SEPARATOR $2)');
  s = s.replace(/\bstrftime\s*\(\s*(__LP_LITERAL_\d+__)\s*,\s*([^()]+)\)/gi, (_, f, expr) => {
    const literal = p.restore(f);
    const format = literal.slice(1, -1).replace(/%M/g, '%i').replace(/%m/g, '%m').replace(/%S/g, '%s');
    if (literal === "'%s'") return `UNIX_TIMESTAMP(${expr})`;
    return `DATE_FORMAT(${expr}, '${format}')`;
  });
  s = s.replace(/\b(datetime|date)\s*\(\s*(__LP_LITERAL_\d+__)\s*(?:,\s*(__LP_LITERAL_\d+__))?\s*\)/gi, (_, fn, value, modifier) => {
    if (p.restore(value) !== "'now'") throw new Error('Unsupported SQLite date argument');
    let expr = 'UTC_TIMESTAMP()';
    if (modifier) {
      const m = p.restore(modifier).match(/^'([+-]?\d+)\s+(days?|hours?|minutes?|seconds?)'$/i);
      if (!m) throw new Error('Unsupported SQLite date modifier');
      expr = `DATE_ADD(${expr}, INTERVAL ${Number(m[1])} ${m[2].replace(/s$/i, '').toUpperCase()})`;
    }
    return fn.toLowerCase() === 'date' ? `DATE(${expr})` : expr;
  });
  // SQLite inline REFERENCES is ignored by MySQL: promote it to a table constraint.
  if (/^\s*CREATE\s+TABLE/i.test(s)) {
    const foreign: string[] = [];
    s = s.replace(/\b(\w+)\s+(INT|BIGINT)([^,]*?)\s+REFERENCES\s+(\w+)\s*\((\w+)\)(\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT))?/gi,
      (_, col, type, attrs, table, key, action) => { foreign.push(`FOREIGN KEY (${col}) REFERENCES ${table}(${key})${action ?? ''}`); return `${col} ${type}${attrs}`; });
    if (foreign.length) s = s.replace(/\)\s*$/, `, ${foreign.join(', ')})`);
    if (!/\bENGINE\s*=/i.test(s)) s += ' ENGINE=InnoDB';
  }
  // key is an identifier in ac_config, not a MySQL keyword there.
  s = s.replace(/\bgroups\b/gi, '`groups`');
  s = s.replace(/\bkey\b/gi, (word, offset: number) => /\b(?:PRIMARY|FOREIGN|DUPLICATE|UNIQUE)\s*$/i.test(s.slice(0, offset)) || /^\s+(?:idx_|lp_)/i.test(s.slice(offset + word.length)) ? word : '`key`');
  return p.restore(s);
}

/** Legacy databases may still have DATETIME columns. Convert only a parameter bound to an
 * actual temporal column, never an ISO-looking password, comment body, identifier, etc. */
async function temporalParams(queryable: {query: Function}, sql: string, params: unknown[]): Promise<unknown[]> {
  const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v);
  if (!params.some(iso)) return params;
  const masked = protectSql(sql);
  const insert = masked.code.match(/^\s*INSERT(?:\s+OR\s+\w+|\s+IGNORE)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  const update = masked.code.match(/^\s*UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s|$)/i);
  const tableToken = insert?.[1] ?? update?.[1];
  if (!tableToken) return params;
  const unquote = (v: string): string => masked.restore(v.trim()).replace(/^[`"]|[`"]$/g, '');
  const table = unquote(tableToken);
  const bindings: Array<{column: string; index: number}> = [];
  let index = 0;
  if (insert) {
    const columns = insert[2].split(',');
    insert[3].split(',').forEach((value, i) => { if (value.trim() === '?') bindings.push({column: unquote(columns[i]), index}); index += (value.match(/\?/g) ?? []).length; });
  } else if (update) {
    for (const assignment of update[2].split(',')) {
      const match = assignment.match(/^\s*(\w+)\s*=\s*\?\s*$/);
      if (match) bindings.push({column: unquote(match[1]), index});
      index += (assignment.match(/\?/g) ?? []).length;
    }
  }
  const candidates = bindings.filter((b) => iso(params[b.index]));
  if (!candidates.length) return params;
  const [columns] = await queryable.query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND DATA_TYPE IN ('datetime','timestamp','date')", [table]);
  const result = [...params];
  for (const binding of candidates) if (columns.some((c: {name: string}) => c.name === binding.column)) result[binding.index] = (params[binding.index] as string).replace('T', ' ').replace(/(?:\.\d+)?Z$/, '');
  return result;
}
export async function compatibleQuery(queryable: { query: Function }, sql: string, params: unknown[] = []): Promise<any> {
  const pragma = sql.match(/^\s*PRAGMA\s+table_info\(['"]?(\w+)['"]?\)\s*;?\s*$/i);
  if (pragma) return queryable.query('SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ORDINAL_POSITION', [pragma[1]]);
  const index = sql.match(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)\s*(\([\s\S]+\))\s*;?\s*$/i);
  if (index) {
    const [rows] = await queryable.query('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1', [index[3], index[2]]);
    if (rows.length) return [{ affectedRows: 0, insertId: 0 }, []];
    try { return await queryable.query(mysqlSql(sql.replace(/IF\s+NOT\s+EXISTS\s+/i, '')), params); }
    catch (error: any) { if (error.code !== 'ER_DUP_KEYNAME') throw error; return [{ affectedRows: 0, insertId: 0 }, []]; }
  }
  return queryable.query(mysqlSql(sql), await temporalParams(queryable, sql, params));
}
