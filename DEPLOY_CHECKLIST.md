# 追光部署清单（你只要做 7 件事，其它我都弄好了）

> 所有自动化已配好：构建脚本、render.yaml、GitHub Actions、SPA fallback、数据库自动初始化、种子数据。
> 本地验证已通过：`npm run build` ✅、生产模式 HTTP 200 ✅、API 返回正常 ✅

---

## 📋 7 步完成部署（每步点链接 → 复制粘贴 → 下一步）

| # | 步骤 | 链接 / 操作 | 需要你填到 Render 的值 |
|---|---|---|---|
| 1 | **推代码到 GitHub** | 在 GitHub 创建空仓库（不要加 README），然后在项目目录跑：<br>`git remote add origin https://github.com/<你的用户名>/zhuiguang.git`<br>`git push -u origin main` | — |
| 2 | **注册 Turso（数据库，免费 9GB）** | 👉 [https://turso.tech](https://turso.tech)（GitHub 一键登录）<br>→ Create Database → 名字随便 → Create<br>→ 点 **Create Token** 复制 token<br>→ 复制数据库 URL（`libsql://...turso.io`） | `TURSO_DATABASE_URL` = 数据库 URL<br>`TURSO_AUTH_TOKEN` = token |
| 3 | **注册 Supabase（文件存储，免费 1GB）** | 👉 [https://supabase.com](https://supabase.com)（GitHub 一键登录）<br>→ New Project → 名字随便选新加坡 → Create new project<br>→ 等 2 分钟 → **Storage** → **New bucket**<br>&nbsp;&nbsp;Bucket name: `zhuiguang-files` → 勾选 **Public** → Create bucket<br>→ **Settings → API**：复制 Project URL 和 service_role key | `SUPABASE_URL` = Project URL<br>`SUPABASE_SERVICE_KEY` = service_role key<br>`SUPABASE_BUCKET` = `zhuiguang-files` |
| 4 | **Render 新建服务** | 👉 [https://dashboard.render.com](https://dashboard.render.com)<br>→ **New → Web Service**<br>→ 连接你第 1 步创建的 `zhuiguang` 仓库<br>→ Render 会自动读取 render.yaml，点 **Create Web Service** | — |
| 5 | **填环境变量** | 在 Render 服务页 → **Environment → Environment Variables**<br>把上面 2、3 步拿到的值一条条 Add：<br>Key 填左边列，Value 填右边列 → Add | `TURSO_DATABASE_URL` = …<br>`TURSO_AUTH_TOKEN` = …<br>`SUPABASE_URL` = …<br>`SUPABASE_SERVICE_KEY` = …<br>`SUPABASE_BUCKET` = `zhuiguang-files`<br>(JWT_SECRET 已经让 Render 自动生成，不用管) |
| 6 | **等部署** | 看 Logs 里出现：<br>`[server] 追光后端运行于 http://localhost:xxxx` + 绿色 Live = 成功 | — |
| 7 | **登录用** | 访问你分配的 `https://zhuiguang.onrender.com`（或你自定义的域名） | 超管：`admin` / `admin123456` |

---

## ⚠️ 3 个小坑（提前避开，少走半小时弯路）

1. **Supabase bucket 必须是 Public 的**：创建 bucket 时勾选 Public，不然上传的图片/文件前端打不开
2. **SUPABASE_SERVICE_KEY 别填成 anon key**：在 Settings → API 里有两个 key，service_role 那个才是，长的
3. **Render 免费实例 15 分钟没访问会休眠**：首次打开要等 10-30 秒冷启动，不影响使用。介意就把 plan 改成 Starter($7/月)

---

## 🔧 后续维护（自动的，不用管）

| 功能 | 已配好 |
|---|---|
| GitHub push → Render 自动重部署 | ✅ autoDeploy: yes |
| 数据库自动建表 + 超管/学科/主题种子数据 | ✅ initDB() 启动时跑 |
| SPA 路由刷新不 404 | ✅ dist/index.html fallback |
| 文件上传走 Supabase 云端，不丢 | ✅ Supabase Storage |
| HTTPS + 自定义域名 | ✅ Render 自带，加条 CNAME 就行 |

---

## ❌ 不部署 Turso+Supabase 会怎样？

Render 没有持久盘，每次部署数据库和上传文件都会清空。
如果不配 Turso，程序可以跑（用本地临时 SQLite），但 **每重启一次管理员账号就没了，数据全丢**。所以 Turso 和 Supabase 一定要配。

---

### 完成后告诉我：
- 部署成功了没？
- Render 日志有没报错？
- 登录后各页面能正常打开吗？
