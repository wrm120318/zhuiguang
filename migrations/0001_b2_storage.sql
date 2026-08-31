-- ============================================================
-- 追光学科共享平台 · B2 存储迁移 D1 schema（v4.4.0）
-- 部署：npx wrangler d1 execute zhuiguang-db --remote --file=migrations/0001_b2_storage.sql
-- 说明：
--   * 全部 CREATE TABLE 用 IF NOT EXISTS，可重复执行（自愈建表）。
--   * resources.file_id 补列：SQLite/D1 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS，
--     幂等由 Worker 中间件在启动时检测后“按需补列”实现（见 worker-api.ts 自动建表段）。
-- ============================================================

-- 1) 统一文件元信息表（D1 是文件元数据唯一来源）
--    backend='b2' 走 B2 私有桶；backend='supabase' 为迁移期孤儿回退。
CREATE TABLE IF NOT EXISTS file_meta (
  file_id          TEXT    PRIMARY KEY,          -- 对外统一 ID（/api/file/{fileId}）
  b2_file_id       TEXT,                         -- B2 原生 fileId（删除时需要）
  original_name    TEXT,
  size             INTEGER,
  mime             TEXT,
  backend          TEXT    DEFAULT 'b2',         -- 'b2' | 'supabase'
  bucket           TEXT,
  object_key       TEXT,                         -- B2 fileName / Supabase key
  is_public        INTEGER DEFAULT 0,           -- 审核通过后翻 1（公开可缓存）
  cacheable        INTEGER DEFAULT 0,           -- 是否允许 CF 边缘缓存
  purpose          TEXT,                         -- avatar|resource|image|article|doc|...
  is_convert_webp  INTEGER DEFAULT 0,            -- 是否经过前端 webp 转码
  file_hash        TEXT,                         -- 内容哈希（sha1/sha256），用于一致性校验
  uploader_id      INTEGER,
  created_at       INTEGER,
  updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_meta_uploader ON file_meta(uploader_id);
CREATE INDEX IF NOT EXISTS idx_file_meta_purpose ON file_meta(purpose);
CREATE INDEX IF NOT EXISTS idx_file_meta_backend ON file_meta(backend);

-- 2) B2 官方 B 类（下载/列表）交易计数 —— 权威值由 Worker 每次真实回源后写入
--    不使用 Worker 内存变量累加（规避多实例漂移，铁律 #4）。
CREATE TABLE IF NOT EXISTS b2_quota_daily (
  day           TEXT    PRIMARY KEY,             -- 'YYYY-MM-DD'（北京时间）
  b_class_count INTEGER DEFAULT 0,               -- 当日 B 类已消耗（真实回源累计）
  last_update   INTEGER
);

-- 3) 用户粒度真实 B2 回源计数（兜底限速，CF 缓存命中不计入）
CREATE TABLE IF NOT EXISTS b2_user_origin (
  day       TEXT    NOT NULL,
  user_id   INTEGER NOT NULL,
  cnt       INTEGER DEFAULT 0,
  PRIMARY KEY (day, user_id)
);
CREATE INDEX IF NOT EXISTS idx_b2_user_origin_uid ON b2_user_origin(user_id);

-- 4) 预热任务记录（管理员手动预热高频资源）
CREATE TABLE IF NOT EXISTS b2_prewarm_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    TEXT,
  operator   INTEGER,
  status     TEXT    DEFAULT 'done',             -- done|failed
  cost_ms    INTEGER,
  created_at INTEGER
);

-- 5) resources 增加 file_id 引用列（幂等补列，真正补列在 Worker 中间件执行）
--    ALTER 语句留作本地/手动执行参考；线上由 Worker 自愈调用。
--    ALTER TABLE resources ADD COLUMN file_id TEXT;

-- 6) 下载性能埋点（缓存命中/回源、耗时），用于监控面板计算缓存命中率与下载速度
--    hit=1 表示 CF 边缘缓存命中（未回源 B2）；hit=0 表示真实回源 B2。
CREATE TABLE IF NOT EXISTS b2_download_metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,
  file_id    TEXT,
  user_id    INTEGER,
  hit        INTEGER DEFAULT 0,           -- 1=缓存命中 0=回源
  is_range   INTEGER DEFAULT 0,           -- 1=Range 分片请求
  cost_ms    INTEGER,                     -- 端到端耗时
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_b2_dm_day ON b2_download_metrics(day);
CREATE INDEX IF NOT EXISTS idx_b2_dm_file ON b2_download_metrics(file_id);

-- ============================================================
-- v4.4.1 新增（C 类交易治理 / 官方容量盘点 / 全量迁移幂等）
-- ============================================================

-- 7) B2 鉴权 token 共享缓存（单行表，id 恒为 1）
--    背景：b2_authorize_account 属 **Class C**（免费账户 2500/日）。
--    原先 token 只存 Worker 模块级变量，而 Cloudflare 在全球多个 PoP
--    各起一个 isolate 且会冷启动回收 → 每个 isolate 首次请求都要花 1 次 C 类。
--    落 D1 后全球 isolate 共享同一 token，正常情况下每日仅 1 次 C 类。
CREATE TABLE IF NOT EXISTS b2_auth_cache (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  token        TEXT    NOT NULL,
  api_url      TEXT    NOT NULL,
  download_url TEXT    NOT NULL,
  account_id   TEXT,
  exp          INTEGER NOT NULL,               -- 过期时间戳（ms），预留 1h 安全余量
  updated_at   INTEGER
);

-- 8) B2 官方容量盘点快照（每日最多 1 次）
--    背景：b2_get_account_info 实测 404；b2_list_buckets 响应**不含**
--    fileCount/totalSize 字段。故「官方已用容量」只能靠 b2_list_file_names
--    全量列举求和（属 Class A，免费 2500/日），因此每日只做一次并落库。
CREATE TABLE IF NOT EXISTS b2_bucket_census (
  day        TEXT    PRIMARY KEY,              -- 'YYYY-MM-DD'（北京时间）
  file_count INTEGER DEFAULT 0,
  total_size INTEGER DEFAULT 0,
  created_at INTEGER
);

-- 9) 存量迁移日志（Supabase → B2，幂等）
--    source_key 为 Supabase 桶内的对象 key，UNIQUE 保证重复执行不会重复上传。
CREATE TABLE IF NOT EXISTS b2_migration_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_backend TEXT   NOT NULL DEFAULT 'supabase',
  source_key    TEXT    NOT NULL UNIQUE,
  file_id       TEXT    NOT NULL,              -- 迁移后的 /api/file/{fileId}
  size          INTEGER,
  mime          TEXT,
  sha1          TEXT,                          -- 迁移前后一致性校验
  refs_updated  INTEGER DEFAULT 0,             -- 改写了多少处 D1 引用
  status        TEXT    DEFAULT 'done',        -- done|failed
  created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_b2_migration_fid ON b2_migration_log(file_id);
