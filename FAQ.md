# 常见问题（FAQ）

> 本文件收集「追光 · 学科共享平台」使用与运维中的高频问题。
> 用户访问地址：https://xkzg.dpdns.org ｜ 默认超管账号：`admin` / `admin123456`

---

## 目录

- [Q1. 网站打不开 / 白屏怎么办？](#q1-网站打不开--白屏怎么办)
- [Q2. 上传文件失败怎么办？](#q2-上传文件失败怎么办)
- [Q3. 如何修改用户密码？](#q3-如何修改用户密码)
- [Q4. 如何开关注册功能？](#q4-如何开关注册功能)
- [Q5. 教师和管理员权限有什么区别？](#q5-教师和管理员权限有什么区别)
- [Q6. 如何部署到 Cloudflare？](#q6-如何部署到-cloudflare)
- [Q7. 数据库在哪里？](#q7-数据库在哪里)
- [Q8. 如何备份数据？](#q8-如何备份数据)
- [Q9. 改了代码为什么用户那边还是老样子？](#q9-改了代码为什么用户那边还是老样子)
- [Q10. 学生上传的美文/资料为什么别人看不到？](#q10-学生上传的美文资料为什么别人看不到)

---

## Q1. 网站打不开 / 白屏怎么办？

### 常见原因与排查

| 现象 | 可能原因 | 解决方法 |
|---|---|---|
| 完全白屏，什么都不显示 | 前端构建未部署 / CDN 缓存旧版本 | 等待 Cloudflare Pages 构建完成（通常 1-2 分钟），然后强刷浏览器（Ctrl+Shift+R） |
| 页面打开但功能点不动 / 登录失败 | 后端 Worker 未部署或地址不对 | 确认 `worker-api.ts` 已 `npx wrangler deploy`；确认前端 `VITE_API_BASE_URL` 指向正确的 Worker 地址 |
| Error 1016 / 530 | （v1.x 隧道时代问题）Pinggy 隧道过期 | v2.0.0 已迁移至 Cloudflare 无服务器架构，不再出现此问题；如仍出现说明未完成迁移 |
| 接口返回 401"登录已过期" | JWT Token 过期（7 天有效） | 重新登录即可 |
| 接口返回 401"账号已被禁用" | 账号被超管禁用 | 联系超管在用户管理中启用账号 |

### 排查步骤

1. **先强刷浏览器**：`Ctrl + Shift + R`（或 `Cmd + Shift + R`），排除浏览器缓存。
2. **打开浏览器开发者工具**（F12）→ Network 面板，看 API 请求是否返回正常（200）。
3. **看 Console 面板**是否有红色报错，截图发给维护者。
4. **确认后端是否正常**：直接访问 Worker 健康检查地址，返回 `OK` 即正常。

### 本地开发白屏

- 确认后端已启动（`npm run dev`，后端运行于 `localhost:3001`）。
- 确认前端已启动（`localhost:5173`）。
- 确认 `vite.config.ts` 中 proxy 配置正确（`/api` → `localhost:3001`）。

---

## Q2. 上传文件失败怎么办？

### 架构说明

项目文件上传采用**前端直传 Supabase presign URL** 方案：

- 所有 **>100KB** 的文件 → 前端直传 Supabase Storage（不走后端）
- **<=100KB** 的小文件 → 走后端接口
- el-upload 组件**必须**使用 `:http-request` 自定义上传，**禁止**用 `:before-upload`

### 常见失败原因

| 现象 | 可能原因 | 解决方法 |
|---|---|---|
| 上传无反应/静默失败 | 误用了 `:before-upload` | 改回 `:http-request`（铁律，见 CONTRIBUTING.md） |
| 大文件（>100KB）上传失败 | Supabase 配置错误 | 检查 `wrangler.toml` 中 `SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、`SUPABASE_BUCKET` 是否正确 |
| 图片上传后打不开 | Supabase Bucket 不是 Public | 在 Supabase 后台将 Bucket `zhuiguang` 设为 Public |
| 上传成功但列表看不到 | 学生上传状态为 pending 待审核 | 这是正常行为，学生自己列表可见"待审核"标签，审核通过后全员可见 |
| presign URL 获取失败 | 后端 Worker 未配置 Supabase 环境变量 | 检查 `wrangler.toml` 的 `[vars]` 中 Supabase 三项是否填写 |

### 排查步骤

1. **确认 Supabase 配置**：
   - `SUPABASE_URL` = `https://njwkkinzgmwzyfifagwl.supabase.co`
   - `SUPABASE_SERVICE_KEY` = service_role key（**不是** anon key，是长的那个）
   - `SUPABASE_BUCKET` = `zhuiguang`
2. **确认 Bucket 权限**：Supabase 后台 → Storage → Bucket `zhuiguang` → 确认为 Public。
3. **F12 Network 面板**：看 presign URL 请求是否返回 200，看直传 Supabase 请求是否返回 200。
4. **测试大文件**：务必测试 1MB 以上文件，不能只测 10KB 小文件。

### 注意

- `SUPABASE_SERVICE_KEY` 必须是 **service_role** key，不是 anon key。在 Supabase 后台 Settings → API 中，有两个 key，选 service_role 那个（较长的）。

---

## Q3. 如何修改用户密码？

### 用户自己修改

1. 登录后进入「个人中心」（Profile 页面）。
2. 找到修改密码入口，输入旧密码和新密码提交。

### 超管重置他人密码

1. 用 `admin` 账号登录管理后台。
2. 进入「用户管理」页面。
3. 找到目标用户，点击「重置密码」。
4. 输入新密码确认。

### 通过 API 重置（超管）

```
POST /api/users/:id/password
Authorization: Bearer <超管token>
Body: { "password": "新密码" }
```

### 忘记超管密码

- 如果记得本地服务器访问权限，可通过数据库直接重置（本地 SQLite 或 D1）。
- D1 方式：`npx wrangler d1 execute zhuiguang-db --remote --command="UPDATE users SET password_hash='<新bcrypt哈希>' WHERE username='admin'"`

---

## Q4. 如何开关注册功能？

### 操作步骤

1. 用超管账号（`admin`）登录管理后台。
2. 左侧菜单进入「功能开关」（FeatureFlagsView）。
3. 找到「自助注册」卡片（门图标）。
4. 切换开关即可开/关注册功能。

### 技术说明

- 开关存储在 D1 数据库 `feature_flags` 表中，key 为 `registration_enabled`。
- 登录页通过 `GET /api/feature-flags/public`（公开接口，无需登录）读取注册开关状态。
- 开关关闭时，登录页不显示注册入口，注册接口拒绝请求。

### 默认状态

- 自助注册默认**开启**。

---

## Q5. 教师和管理员权限有什么区别？

项目采用三角色体系，角色名为固定字符串（**禁止修改**）：

### 权限对比

| 功能 | SUPER_ADMIN（超管） | TEACHER（教师） | STUDENT（学生） |
|---|---|---|---|
| 用户管理（增删改查） | 可以 | 不可以（403） | 不可以 |
| 功能开关 | 可以 | 不可以（403） | 不可以 |
| 经验规则设置 | 可以 | 不可以（403） | 不可以 |
| 主题配置 | 可以 | 不可以 | 不可以 |
| 删除用户 | 可以 | 不可以（403） | 不可以 |
| 全部学科管理 | 可以 | 仅本学科 | 不可以 |
| 班级管理 | 可以 | 仅本班 | 不可以 |
| 发布美文/资料 | 直接 approved | 直接 approved | pending 待审核 |
| 审核美文/资料 | 可以 | 可以（本学科） | 不可以 |
| 创建题库/成绩 | 可以 | 可以（本学科） | 不可以 |
| 答题/单题训练 | 可以 | 可以 | 可以 |
| 查询成绩 | 可以 | 可以 | 可以 |
| 站内信 | 可以 | 可以 | 可以 |
| 发布美文 | 可以 | 可以 | 可以（待审核） |

### 关键区别

- **超管**：全站最高权限，管理所有用户、学科、班级、系统配置。
- **教师**：仅管理自己任教的学科和班级，发布内容直接通过，**不能**管理用户和系统配置。
- **学生**：基础使用权限，发布内容需审核，可答题、查成绩、发站内信。

### 权限实现

- 敏感接口统一使用 `requireRole('SUPER_ADMIN')` 中间件保护。
- 前端菜单通过 computed 按角色过滤显示。
- 教师访问用户管理等接口会返回 403。

---

## Q6. 如何部署到 Cloudflare？

### 前提条件

- Cloudflare 账号（已有，绑定 `xkzg.dpdns.org`）
- Supabase 账号（已有，Project: `njwkkinzgmwzyfifagwl`）
- 全程零绑卡

### 部署步骤（概要）

详细步骤见 `Workers-D1上云指南.md`。

**第一步：创建 D1 数据库**
```bash
npx wrangler d1 create zhuiguang-db
# 把返回的 database_id 填入 wrangler.toml
```

**第二步：建表 + 迁移数据**
```bash
npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql
bash scripts/migrate-to-d1.sh   # 如有存量数据
```

**第三步：配置环境变量**

编辑 `wrangler.toml`，填写：
- `JWT_SECRET`
- `SUPABASE_URL` = `https://njwkkinzgmwzyfifagwl.supabase.co`
- `SUPABASE_SERVICE_KEY` = service_role key
- `SUPABASE_BUCKET` = `zhuiguang`

**第四步：部署后端 Worker**
```bash
npm install hono
npx wrangler deploy
# 获得 Worker URL：https://zhuiguang-api.<子域名>.workers.dev
```

**第五步：部署前端到 Cloudflare Pages**

1. Cloudflare Dashboard → Pages → Create project → Connect to Git
2. 选择 GitHub 仓库 `wrm120318/zhuiguang`
3. 构建命令：`npm run build`
4. 输出目录：`dist`
5. 环境变量：`VITE_API_BASE_URL` = Worker URL
6. 绑定自定义域名 `xkzg.dpdns.org`

**第六步：验证**

访问 https://xkzg.dpdns.org，用 `admin / admin123456` 登录。

### 注意事项

- 改了 `worker-api.ts` 须手动 `npx wrangler deploy`（Pages 不会自动部署 Worker）。
- 改了 `schema.sql` 须手动 `npx wrangler d1 execute`。
- 改了前端代码，push 到 GitHub 后 Pages 自动重新构建。
- 密钥（`.env`）不入库，云端在 `wrangler.toml` 或 Cloudflare Dashboard 配置。

---

## Q7. 数据库在哪里？

### 生产环境（v2.0.0）

- **数据库类型**：Cloudflare D1（SQLite 兼容，无服务器）
- **数据库名**：`zhuiguang-db`
- **database_id**：见 `wrangler.toml`（`996ab327-1a44-47fb-ac1d-5ab963dd04a5`）
- **管理方式**：通过 `wrangler` CLI 或 Cloudflare Dashboard

### 常用数据库操作

```bash
# 查询用户数
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT COUNT(*) FROM users"

# 查看所有表
npx wrangler d1 execute zhuiguang-db --remote --command=".tables"

# 执行建表脚本
npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql

# 执行任意 SQL
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT * FROM users WHERE username='admin'"
```

### 本地开发环境

- **数据库类型**：SQLite（本地文件）
- **文件路径**：`server/local.db`
- **首次运行**后端自动建表 + 写入种子数据（超管、班级、学科、主题）
- **不入库**：`server/local.db` 在 `.gitignore` 中排除

### 数据库结构

共 23 张表，建表脚本见 `schema.sql`。表清单见 `README.md` 技术架构总览章节。**禁止**随意 ALTER 表或删表。

---

## Q8. 如何备份数据？

### 方式一：D1 远程导出（推荐）

```bash
# 导出每张表数据为 SQL（示例：导出 users 表）
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT * FROM users" --json > backup_users.json

# 或导出为 SQL INSERT 语句（需逐表操作）
```

### 方式二：本地 SQLite 备份

如果还在使用本地 SQLite（`server/local.db`）：

```bash
# 使用项目自带脚本
bash scripts/backup-sqlite.sh

# 或手动备份
cp server/local.db server/local.db.backup_$(date +%Y%m%d_%H%M%S)
```

项目已有备份示例：
- `server/local.db.backup_20260804_122024`
- `server/local.db.backup_20260804_130620_bugfix9`
- `server/local.db.backup_20260804_140130_after_9bugs_fix`
- `server/local.db.backup_20260805_014551_before_worker_v5`

### 方式三：从 D1 迁移到本地

```bash
# 将 D1 数据导出到本地文件
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT * FROM users" --json > /tmp/users_export.json
```

### 备份建议

- **每次发版前**必须备份（铁律，见 CONTRIBUTING.md 第七节）。
- 重大变更（如 Bug 修复、架构迁移）前后各备份一次。
- 备份文件命名带时间戳和原因（如 `before_worker_v5`、`after_9bugs_fix`）。
- D1 数据也可通过 Cloudflare Dashboard 导出。

### 恢复数据

```bash
# 本地 SQLite 恢复
cp server/local.db.backup_YYYYMMDD server/local.db

# D1 恢复（通过执行备份的 SQL）
npx wrangler d1 execute zhuiguang-db --remote --file=backup.sql
```

---

## Q9. 改了代码为什么用户那边还是老样子？

### 原因

浏览器缓存了旧的 JavaScript 文件（如 `index-XXXX.js`），用户加载的还是旧版本。

### 解决方法

1. **强刷浏览器**：`Ctrl + Shift + R`（或 `Cmd + Shift + R`）。
2. **确认构建已部署**：Cloudflare Pages push 后需等 1-2 分钟构建完成。
3. **版本戳机制**：项目在 `dist/index.html` 中注入 `?v=时间戳` 版本戳，确保每次部署后浏览器加载新文件。**禁止删除此逻辑**（见 CONTRIBUTING.md 第六节）。

### 预防

- 发布后自己先打开 https://xkzg.dpdns.org 验证（铁律，见 CONTRIBUTING.md）。
- 告诉用户强刷浏览器或清除缓存。

---

## Q10. 学生上传的美文/资料为什么别人看不到？

### 这是正常行为，不是 Bug

项目审核规则（铁律，禁止修改）：

- **超管/教师上传** → 直接 `approved`，立刻全员可见
- **学生上传** → 状态 `pending`，等待审核
- 学生**自己**的列表可以看到自己的 `pending`（"待审核"标签）
- 审核通过后（`approved`）全员可见

### 解决方法

1. 学生上传后，内容进入待审核队列。
2. 超管或本学科教师在「审核管理」页面审核。
3. 审核通过后，内容对全员可见。
4. 审核驳回（`rejected`），内容仅作者可见，作者可修改后重新提交。

### 注意

- 学生自己的列表**必须**能看到自己的 pending 内容（铁律，禁止列表只加载 approved）。
- 审核通过后，经验值加给**原作者**，不是审核人（Bug1 修复，禁止改回）。

---

## 其他常见问题

### Q. 如何添加新学科？

超管登录 → 学科管理 → 新增学科（名称、图标、颜色、描述、模块配置）。

### Q. 如何把学生分配到班级？

超管登录 → 班级管理 → 选择班级 → 添加成员（选择用户、角色、学科）。

### Q. 经验值怎么获得？

| 行为 | 经验 |
|---|---|
| 每日登录 | 每天 1 次 |
| 发布美文 | 审核通过后获得 |
| 答题 | 按得分获得 |
| 其他行为 | 见经验规则配置 |

注意：同一天同一用户登录 N 次只计 1 次经验（铁律，禁止改成每次都给）。

### Q. 站内信能发给谁？

全部活跃用户（除自己）都可以发，包括学生给教师发、学生给学生发。联系人列表显示全部活跃用户（铁律，禁止限制范围）。

### Q. 如何联系维护者？

- GitHub Issues：https://github.com/wrm120318/zhuiguang/issues
- 项目负责人 GitHub 账号：`wrm120318`
