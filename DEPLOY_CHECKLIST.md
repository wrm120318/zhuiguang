# 追光部署清单（Cloudflare Workers + D1 + Pages）

> 全免费、零绑卡、无服务器架构。GitHub push 自动构建前端，wrangler CLI 部署后端。
> 本地验证已通过：`npm run build` 通过、线上 HTTP 200 正常。

---

## 前提条件

| 服务 | 用途 | 状态 |
|---|---|---|
| Cloudflare 账号 | Pages 前端 + Workers 后端 + D1 数据库 | 已有 |
| Supabase 账号 | 文件存储（Bucket: `zhuiguang`，Public） | 已有 |
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
| `SUPABASE_URL` | Supabase 项目 URL | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service_role key | Supabase Dashboard → Settings → API → service_role（**不是** anon key） |
| `SUPABASE_BUCKET` | Supabase 存储桶名 | 固定值 `zhuiguang` |

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

### 第六步：验证

访问 https://xkzg.de5.net，使用 `admin / admin123456` 登录，确认各功能正常。

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
