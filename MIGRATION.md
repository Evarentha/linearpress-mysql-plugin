# MySQL 8 driver and migration contract

The supported compatibility target is **MySQL 8.0.13+ (tested 8.4.6)**. `src/sql-compat.ts` translates the SQL forms used by bundled plugins: SQLite inline integer foreign keys, AUTOINCREMENT, text/index types, conflict updates/ignore/replace, idempotent indexes, table_info, NOCASE, group_concat separators and strftime/date/datetime. Quoted strings, comments and quoted identifiers are protected before transformations. Unsupported syntax fails normally; only duplicate index-name races are recognized. INSERT OR IGNORE becomes a duplicate-key no-op, not MySQL INSERT IGNORE (which would hide truncation/FK errors).

Payload TEXT remains LONGTEXT; known indexed identifiers have explicit widths. Millisecond counters/times use BIGINT. Date-string columns preserve ISO input rather than globally rewriting parameters. Legacy actual DATETIME/TIMESTAMP columns are detected through information_schema and only their directly bound INSERT/UPDATE parameters are normalized. This is a known-SQL compatibility layer, not a general SQLite parser or support for arbitrary third-party SQL.

## Safe migration

- Backend rejects migration while MySQL is active/configured and rejects **every nonempty target business table**, including unknown tables. There is no DELETE/rebuild mode.
- A target advisory lock prevents concurrent migrations; the data phase uses SERIALIZABLE, locks and rechecks all target tables. The route enters maintenance and serializes requests. Stop external writers/background integrations and back up SQLite/files before running a production migration; maintenance cannot stop external database writers.
- All SQLite business tables and explicit plugin indexes are discovered, ordered by FK dependencies and copied. Included: pages, media metadata, profiles, auth/2FA/captcha, comments metadata, categories/tags/options, schedules, SEO and import comment mappings. Unexpected cyclic dependencies fail rather than disable integrity checks.
- Exclusions: `plugins` is local installation/activation metadata; `settings` contains local site/plugin configuration and runtime permission definitions; `ifwp_media_map` is a local downloaded-file cache, not media business metadata. These intentionally remain on infrastructure SQLite. `groups` and permissions stored in groups **are copied**. `media_library` and `ifwp_comment_map` **are copied**.
- MySQL DDL implicitly commits. Schema/index creation is separate from the single transaction copying all rows. Failure may leave empty tables/indexes, but does not enable the new driver or write `migratedAt`. Configuration publication is atomic and only after commit. Retrying an empty failed target is safe; nonempty targets are rejected.
- FK upgrade archives orphan comments in `_lp_orphan_comments` before deleting comments whose post is missing or nulling missing users. Archive+cleanup is transactional. Constraint ALTER is atomic and retryable. Invalid post-author/user-group links fail startup and require operator repair instead of deleting business content.

## Verification

`node Base/node_modules/tsx/dist/cli.mjs .pi/fixes/storage-regression.mts`

Tests use an isolated database named `lp_fix_storage_regression` on the temporary MySQL instance described by `LP_MYSQL_PORTABLE/instance.json` (default test path in script), and drop only that test database. No credentials are committed. The all-plugin audit SQLite corpus is used if available. SSRF tests inject DNS and transport mocks and never request real internal services. Actual MySQL tests cover migration, plugin copies, target refusal, transaction rollback, new and upgraded FKs, plugin DDL, indexes, UPSERT, aggregation, dates and string fidelity. Full application lifecycle integration is separately owned by the lifecycle repair.
