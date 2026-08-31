# 追光部署清单（Cloudflare Workers + D1 + Pages）

> 全免费、零绑卡、无服务器架构。GitHub push 自动构建前端，wrangler CLI 部署后端。
> 本地验证已通过：`npm run build` 通过、线上 HTTP 200 正常。

---

## 前提条件

| 服务 | 用途 | 状态 |
|---|---|---|
| Cloudflare 账号 | Pages 前端 + Workers 后端 + D1 数据库 | 已有 |
| Supabase 账号 | 文件存储（迁移期孤儿回退用，Bucket: `zhuiguang`） | 已有 |
| Backblaze B2 账号 | **主文件存储（私有桶 `zhuiguang-k12-004`，免费模式）** | 已有 |
| GitHub 账号 | 代码仓库 + Pages 自动部署触发 | 已有 |

---

## 部署步骤

### 第一步：创建 D1 数据库（首次部署）

```bash
npx wrangler d1 create zhuiguang-db
# 将返回的 database_id 填入 wrangler.toml
```

### 第二步：建表 + 写入种子数据

```bash
# 建表（24 张表 + 索引，幂等 IF NOT EXISTS）
npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql

# 验证
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT COUNT(*) FROM users"
```

### 第三步：配置环境变量

编辑 `wrangler.toml`，填写以下配置：

| 变量名 | 说明 | 获取位置 |
|---|---|---|
| `JWT_SECRET` | JWT 签名密钥 | 自行生成随机字符串（32 位以上） |
| `SUPABASE_URL` | Supabase 项目 URL（迁移期回退用） | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service_role key | Supabase Dashboard → Settings → API → service_role（**不是** anon key） |
| `SUPABASE_BUCKET` | Supabase 存储桶名 | 固定值 `zhuiguang` |
| `STORAGE_MODE` | 存储后端模式 | 固定 `B2_FREE`（B2_PAID / SUPABASE 可回滚） |
| `B2_KEY_ID` | B2 主应用程序密钥 ID | B2 Dashboard → App Keys |
| `B2_APPLICATION_KEY` | B2 主应用程序密钥 | B2 Dashboard → App Keys |
| `B2_BUCKET_ID` | B2 私有桶 ID | B2 Dashboard → Buckets → `zhuiguang-k12-004` |
| `B2_BUCKET_NAME` | B2 私有桶名 | `zhuiguang-k12-004` |
| `B2_ACCOUNT_ID` | B2 账户 ID | 即主密钥 Key ID |
| `B2_QUOTA_ALERT` | 回源告警阈值 | 默认 `2200` |
| `B2_USER_DAILY_ORIGIN_LIMIT` | 用户日回源限速 | 默认 `100` |
| `CACHE_TTL_PUBLIC` / `CACHE_TTL_WEBP` / `CACHE_TTL_PRIVATE` | 缓存 TTL（秒） | 默认 `86400` / `2592000` / `0` |

> **密钥不入库**：`wrangler.toml` 已在 `.gitignore` 中排除；B2 变量名以 `worker-api.ts` / `storage-layer.ts` 读取的为准（`B2_KEY_ID` 等，非 `B2_APPLICATION_KEY_ID`）。

### 第四步：部署后端 Worker

```bash
cd /workspace
source .env
npx wrangler deploy
# 输出 Worker URL：https://zhuiguang-api.<子域名>.workers.dev
```

> **注意**：`source .env` 加载 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 后，`wrangler deploy` 才能正常工作。Pages 不会自动部署 Worker，改了 `worker-api.ts` 必须手动执行此步。

### 第五步：部署前端到 Cloudflare Pages

1. Cloudflare Dashboard → Pages → Create project → Connect to Git
2. 选择 GitHub 仓库 `wrm120318/zhuiguang`
3. 构建命令：`npm run build`
4. 输出目录：`dist`
5. 绑定自定义域名 `xkzg.de5.net`

> Git push 到 main 分支后 Pages 会自动构建，无需手动操作。

### 第六步：B2 存储建表（v4.4.0 / v4.4.1 新增）

```bash
npx wrangler d1 execute zhuiguang-db --remote --file=migrations/0001_b2_storage.sql
```

- v4.4.0：`file_meta` / `b2_quota_daily` / `b2_user_origin` / `b2_prewarm_log` / `b2_download_metrics`，并给 `resources` 补 `file_id` 列。
- v4.4.1：**`b2_auth_cache`（关键，治理 C 类交易）** / `b2_bucket_census`（官方容量盘点快照） / `b2_migration_log`（迁移幂等）。

表均 `IF NOT EXISTS` 幂等，可重复执行。**Worker 启动时也会自愈建表**，故此步主要用于本地/手动场景。

### 第七步：存量迁移 Supabase → B2（部署后执行）

> v4.4.1 重写：旧版从 D1 查 `file_path LIKE '%supabase%'` 一条都匹配不到（D1 存的是纯文件名），
> 导致迁移永远 `total=0`。新版直接全量列举 Supabase 桶。

```bash
# ① 先只盘点不搬迁（dryRun），确认待迁文件清单
curl -X POST https://<worker域名>/api/admin/migrate/to-b2 \
  -H "Authorization: Bearer <超管token>" \
  -H "Content-Type: application/json" -d '{"dryRun":true}'

# ② 全量迁移（幂等，可重复执行；默认不删 Supabase 源文件）
curl -X POST https://<worker域名>/api/admin/migrate/to-b2 \
  -H "Authorization: Bearer <超管token>" \
  -H "Content-Type: application/json" -d '{}'

# ③ 查进度
curl https://<worker域名>/api/admin/migrate/status -H "Authorization: Bearer <超管token>"
```

迁移是「复制」非「移动」，旧 Supabase 文件保留作兜底。迁移会自动改写 D1 中的引用：
`resources.file_path` / `users.avatar` / `articles.cover` / `articles.images` / `pages.cover` /
`pages.images` / `pages.attachments` / `messages.attachments` / `quiz_questions.attachments` /
`subject_questions.attachments`，改写后前端拿到的仍是同一语义的 `/api/file/{fileId}`。

**更省事的做法**：管理后台 → 运行监控 → **B2 存储** → 「存量迁移」卡片 → 点「仅盘点」再点「全量迁移」。

### 第七步（附）：B2 官方容量盘点（每日限 1 次，消耗 Class A）

管理后台 → 运行监控 → **B2 存储** → 容量进度条下方「立即盘点」。
或命令行：

```bash
curl -X POST https://<worker域名>/api/admin/storage/census \
  -H "Authorization: Bearer <超管token>" \
  -H "Content-Type: application/json" -d '{}'
```

### 第八步：验证

访问 https://xkzg.de5.net，使用 `admin / admin123456` 登录，确认各功能正常。
管理后台 → 运行监控 → **B2 存储** tab，确认显示：后端模式、官方容量（含盘点日期）、
今日回源（标注非官方）、缓存命中率、下载耗时、迁移进度。

**验证清单**：

1. 上传一个新文件（任意类型）→ 能正常下载、预览
2. 再下载同一文件 → 「回源耗时」应显著下降（边缘缓存命中）
3. 打开监控面板刷新 5 次 → 去 B2 控制台看「Class C transactions today」应**基本不增长**
4. 执行「全量迁移」→ 15 个存量文件搬完，且原资源仍能正常下载

---

## 日常维护命令速查

| 操作 | 命令 |
|---|---|
| 部署后端 | `cd /workspace && source .env && npx wrangler deploy` |
| 部署前端 | `git push origin main`（Pages 自动构建） |
| 构建前端 | `cd /workspace && npm run build` |
| 查询 D1 | `npx wrangler d1 execute zhuiguang-db --remote --command="SQL"` |
| 执行建表脚本 | `npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql` |
| Workers 实时日志 | `cd /workspace && npx wrangler tail` |
| 本地开发 | `npm run dev`（前端 5173 + 后端 3001） |

---

## 域名与访问

| 用途 | 地址 |
|---|---|
| 用户访问 | https://xkzg.de5.net |
| 后端 API | https://api.xkzg.dpdns.org（同源模式 `/api/xxx`） |
| Supabase | https://njwkkinzgmwzyfifagwl.supabase.co（Bucket: `zhuiguang`） |

---

## 注意事项

1. **Supabase Bucket 必须是 Public**：否则上传的图片/文件前端打不开
2. **SUPABASE_SERVICE_KEY 是 service_role key**：不是 anon key，在 Settings → API 中选较长的那个
3. **改了 `worker-api.ts` 须手动 `npx wrangler deploy`**：Pages 不会自动部署 Worker
4. **改了 `schema.sql` 须手动执行**：`npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql`
5. **密钥不入库**：`.env` 和 `server/local.db` 在 `.gitignore` 中排除
6. **Cloudflare 免费额度充足**：Workers 10 万请求/天、D1 5GB、Pages 无限请求
7. **v3.0 视觉资源需随前端一起推送**：`public/fonts/noto-serif-sc-{600,700,800}.woff2`（自托管衬线字体）与 `public/bg/inkgold-paper*.svg`（主题背景图）必须进 Git 仓库，Pages 构建时 Vite 原样拷到 `dist/`。若这些文件漏推，墨金主题会变回无衬线字体 / 无背景图（玻璃无物可透）。
8. **主题切换验证**：发布后需分别用超管在后台切 `designMode=classic/inkgold` + `inkgoldTone=light/dark`，确认三档（经典/墨金浅/墨金深）前台均正常渲染、无矩形边框、无金色直角输入框。

---

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|---|---|---|
| 前端白屏 | Pages 构建未完成 / CDN 缓存旧版本 | 等 1-2 分钟构建完成，强刷浏览器 Ctrl+Shift+R |
| 接口返回 401 | JWT Token 过期（7 天有效） | 重新登录 |
| 接口返回 500 | Worker 未部署 / 代码报错 | `npx wrangler tail` 查看日志，确认 `wrangler deploy` 已执行 |
| 大文件上传失败 | Supabase 配置错误 | 检查 `wrangler.toml` 中 Supabase 三项配置 |
| 图片打不开 | Supabase Bucket 不是 Public | Supabase 后台将 Bucket `zhuiguang` 设为 Public |
| 改了代码用户看不到 | 浏览器缓存旧 JS | 强刷浏览器，版本戳机制会自动更新 |
