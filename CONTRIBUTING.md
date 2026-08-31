# 贡献指南（CONTRIBUTING）

> 欢迎参与「追光 · 学科共享平台」的开发与维护。本规范是项目维护的铁律，源自真实踩坑经验，请务必逐条遵守。
>
> 项目定位：**维护者，不是重写者。** "它能跑"就是最高标准，不要为技术优雅引入新 Bug。

---

## 目录

- [一、代码编写规范](#一代码编写规范)
- [二、目录修改规则](#二目录修改规则)
- [三、代码分支管理机制](#三代码分支管理机制)
- [四、提交注释标准](#四提交注释标准)
- [五、新增功能开发流程](#五新增功能开发流程)
- [六、禁止修改代码区块标注](#六禁止修改代码区块标注)
- [七、测试要求](#七测试要求)

---

## 一、代码编写规范

### 1.1 通用原则

- **能跑优先**：不引入新依赖、不升级版本、不重构已有逻辑，除非不这样做就跑不起来。
- **最小改动**：只改需要改的地方，不顺手"优化"无关代码。
- **防御逻辑保留**：已修好的 Bug 防御逻辑（如 BigInt 转 Number、路由顺序、权限校验）不得删除。
- **先读文档再碰代码**：改代码前必须先读 `交接文档_追光学科共享平台.md`，重点是第 7 章（文件上传架构）、第 10 章（已修复 Bug 清单）、第 15 章（严格约束）。

### 1.2 前端规范（src/）

- 框架：Vue 3 组合式 API（`<script setup lang="ts">`）+ TypeScript。
- UI 组件库：Element Plus，通过 `unplugin-auto-import` / `unplugin-vue-components` 按需自动导入，**无需手动 import**。
- 状态管理：Pinia（`src/store/`）。
- 路由：Vue Router（`src/router/index.ts`）。
- API 请求：统一使用 `src/api/http.ts` 导出的 axios 实例，**禁止**在组件内直接 `new axios`。
- 路径别名：`@` 指向 `src/`（如 `import http from '@/api/http'`）。
- 环境变量：前端通过 `import.meta.env.VITE_*` 读取，构建时注入。

### 1.3 后端规范（worker-api.ts / server/）

- 生产后端：`worker-api.ts`（Hono 框架，Cloudflare Workers 运行）。
- 本地开发后端：`server/index.ts`（Express，仅本地开发用，与 Worker 保持路由一致）。
- 数据库操作（D1）：
  - `all(sql, ...args)` — 查询多行
  - `get(sql, ...args)` — 查询单行
  - `run(sql, ...args)` — 执行写操作
- JWT 认证：`auth` 中间件验证 Bearer Token，并检查账号是否被禁用。
- 返回值：BigInt 必须显式 `Number()` 转换后再 JSON 序列化（否则报错）。
- 路由顺序：具体路由（如 `/articles/pending-student`）必须放在通配路由（如 `/:id`）**之前**。

### 1.4 文件上传规范（铁律）

- el-upload 组件**必须**使用 `:http-request="customRequest"` 自定义上传。
- **禁止**使用 `:before-upload`（异步失败被静默吞，用户无感知）。
- 所有文件（图片/文档/头像/封面/附件）统一经后端 Worker 代理上传：前端 `POST /api/upload/image`（图片）或 `/api/upload/file`（文档），由 Worker 写 B2 私有桶，返回 `/api/file/{id}`。
- **禁止**改回前端直传 Supabase presign URL（v4.4.0 起已废弃）。
- 涉及上传的页面改一个都不能漏（清单见交接文档第 7.2 节）。

### 1.5 命名规范

- 角色名固定字符串：`SUPER_ADMIN` / `TEACHER` / `STUDENT`，**禁止修改**。
- 数据库表名、字段名以 `schema.sql` 为准，**禁止**随意 ALTER 表。
- 文件名：Vue 组件用 PascalCase（如 `ArticleView.vue`），TS 文件用 kebab-case 或 camel-case（保持与现有一致）。

---

## 二、目录修改规则

### 2.1 可修改的目录

| 目录 | 说明 | 注意事项 |
|---|---|---|
| `src/views/` | 新增/修改页面视图 | 新页面需在 `src/router/index.ts` 注册路由 |
| `src/components/` | 新增/修改公共组件 | — |
| `src/api/index.ts` | 新增 API 接口定义 | 统一走 `http.ts` 实例 |
| `src/store/` | 新增/修改 Pinia store | — |
| `src/utils/` | 新增工具函数 | — |
| `src/types/index.ts` | 新增类型定义 | — |

### 2.2 谨慎修改的目录/文件

| 文件/目录 | 原因 |
|---|---|
| `worker-api.ts` | 生产后端核心，改动需充分测试所有相关路由 |
| `server/index.ts` | 本地后端，须与 Worker 保持逻辑一致 |
| `schema.sql` | 数据库结构，禁止随意 ALTER 表/删表 |
| `wrangler.toml` | 部署配置，密钥不入库 |
| `src/router/index.ts` | 路由含权限守卫，改动需检查角色可见性 |
| `src/layouts/AdminLayout.vue` | 后台布局含权限菜单过滤与修复按钮 |

### 2.3 禁止修改/删除的文件

| 文件 | 原因 |
|---|---|
| `public/_headers` `public/_redirects` | Cloudflare Pages 的 SPA fallback 与缓存策略，删除会导致刷新 404 |
| `dist/index.html` 中的 `?v=` 时间戳逻辑 | 浏览器缓存旧 JS 会导致"改了用户看不到"，禁止删除 |
| `.gitignore` 中对 `.env`、`server/local.db` 的排除 | 防止密钥和本地数据库入库 |
| 任何已修复 Bug 的防御代码 | 详见交接文档第 10 章 |

### 2.4 禁止新增的文件类型

- **禁止**新增需要绑卡/充值的服务配置。
- **禁止**新增第二个启动脚本（统一用 `start-all.sh`）。
- **禁止**新增新的隧道工具配置。
- **禁止**提交 `.env`、`*.db`、`*.pem`、`node_modules/`。

---

## 三、代码分支管理机制

### 3.1 分支模型

本项目采用简化的主干开发模型，适合小团队：

| 分支 | 用途 | 命名规范 |
|---|---|---|
| `main` | 生产分支，始终保持可部署状态 | 固定 `main` |
| `dev` | 开发集成分支（可选） | 固定 `dev` |
| 功能分支 | 新功能开发 | `feat/<功能简述>` |
| 修复分支 | Bug 修复 | `fix/<bug简述>` |
| 热修复分支 | 紧急生产修复 | `hotfix/<问题简述>` |

### 3.2 分支操作流程

```bash
# 1. 从 main 拉取最新代码
git checkout main
git pull origin main

# 2. 创建功能分支
git checkout -b feat/article-search

# 3. 开发并提交（见第四节提交规范）
git add <相关文件>
git commit -m "feat(美文): 新增按标签搜索功能"

# 4. 推送分支
git push origin feat/article-search

# 5. 在 GitHub 创建 Pull Request → main
# 6. Code Review 通过后合并到 main
# 7. main 分支触发 Cloudflare Pages 自动构建部署
```

### 3.3 合并规则

- 功能分支合并到 `main` 前，须本地通过 `npm run build`（类型检查 + 构建）。
- 涉及后端 `worker-api.ts` 的改动，须手动 `npx wrangler deploy` 部署 Worker（Pages 不会自动部署 Worker）。
- 合并冲突优先用 `git pull --rebase origin main` 解决。
- 禁止 `git push --force` 到 `main` 分支。

---

## 四、提交注释标准

### 4.1 提交信息格式

采用 Conventional Commits 规范：

```
<type>(<scope>): <subject>

<body>（可选）
```

### 4.2 type 类型

| type | 说明 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(题库): 新增测验成绩导出 Excel` |
| `fix` | Bug 修复 | `fix(美文): 修复审核后作者被篡改问题` |
| `docs` | 文档更新 | `docs: 更新 README 部署步骤` |
| `style` | 代码格式（不影响逻辑） | `style: 统一缩进` |
| `refactor` | 重构（无功能变化） | 慎用，须确认不引入新 Bug |
| `chore` | 构建/工具/依赖 | `chore: 更新 .gitignore` |
| `hotfix` | 紧急生产修复 | `hotfix(上传): 修复大文件直传失败` |

### 4.3 scope 范围（参考）

`美文` `资料` `题库` `单题训练` `成绩查询` `站内信` `经验值` `用户` `学科` `班级` `上传` `权限` `主题` `部署`

### 4.4 提交规则

- **一次提交只做一件事**：不要在一个 commit 里混合多个无关改动。
- **subject 简明扼要**：不超过 50 字，说清改了什么。
- **body 说明原因**（可选）：为什么改、改了什么逻辑、有什么注意事项。
- **禁止提交密钥**：`.env`、Token、Service Key 等绝不入库。
- 示例：

```
fix(美文): 修复评论接口 BigInt 序列化报错

SQLite 返回的 lastInsertRowid 为 BigInt，JSON.stringify 报错。
评论接口显式 Number() 转换后返回。

涉及文件: server/index.ts, worker-api.ts
```

---

## 五、新增功能开发流程

### 5.1 开发前（搞清 5 个 W）

动手前必须明确，模糊就问，不要猜：

- **Who**：谁用？（学生 / 教师 / 超管）
- **What**：改什么功能？（改现有行为还是加新按钮）
- **When**：哪里触发？（点哪个按钮）
- **Where**：哪个页面？（路由是什么）
- **How**：验收标准是什么？（用户怎么做才能证明改好了）

### 5.2 涉及架构变更的特别规则

凡是涉及以下任何一项，**不要直接做**，先写评估报告交项目负责人确认：

- 换部署平台
- 换隧道工具
- 换数据库
- 换存储服务
- 改项目结构（目录大改/框架大改）
- 新增需要注册账号/绑卡/充值的服务

评估报告需包含：优点、缺点、是否影响现有数据（是否需迁移）、用户需做什么操作、风险点。

### 5.3 开发流程

```
1. 拉取最新代码，创建功能分支
2. 【前端】在 src/views/ 新增页面，src/router/index.ts 注册路由（注意角色权限守卫）
3. 【前端】在 src/api/index.ts 新增接口，src/types/index.ts 补充类型
4. 【后端】在 worker-api.ts 新增路由（注意路由顺序、权限中间件、BigInt 转换）
5. 【后端】同步修改 server/index.ts（保持本地开发一致）
6. 本地 npm run dev 调试
7. npm run build 确认类型检查通过
8. 三角色测试 + 大文件上传测试（见第七节）
9. 提交代码，推送分支，创建 PR
10. PR 合并后：
    - 前端：git push origin main，Cloudflare Pages 自动构建部署
    - 后端（worker-api.ts）：手动 `cd /workspace && source .env && npx wrangler deploy`
```

### 5.4 发布流程

```
1. git push origin main（推送到 GitHub）
2. Cloudflare Pages 自动构建部署前端
3. 如改了 worker-api.ts → npx wrangler deploy（手动部署后端）
4. 访问 https://xkzg.de5.net 验证
5. 如改了 schema.sql → npx wrangler d1 execute（手动执行建表/迁移）
```

---

## 六、禁止修改代码区块标注

项目中存在大量已修复 Bug 的防御逻辑和关键配置，这些代码块**禁止删除、禁止修改、禁止重构**。以下为关键标注清单（完整列表见交接文档）：

### 6.1 文件上传相关

| 位置 | 内容 | 禁止操作 |
|---|---|---|
| 所有 el-upload 组件 | `:http-request` 自定义上传 | 禁止改回 `:before-upload` |
| 上传逻辑 | 所有文件经 Worker 代理（`/api/upload/image`、`/api/upload/file`）写 B2 | 禁止改回前端 Supabase presign 直传 |

### 6.2 缓存控制

| 位置 | 内容 | 禁止操作 |
|---|---|---|
| 静态资源 `?v=` 时间戳 | dist/index.html 注入版本戳 | 禁止删除（否则用户缓存旧 JS） |

### 6.3 数据库与权限

| 位置 | 内容 | 禁止操作 |
|---|---|---|
| 角色名常量 | `SUPER_ADMIN` / `TEACHER` / `STUDENT` | 禁止改名、禁止新增角色 |
| schema.sql | 24 张表结构 | 禁止随意 ALTER 表/删表 |
| 权限中间件 | `requireRole('SUPER_ADMIN')` 敏感接口保护 | 禁止降级为 `requireStaff` |

### 6.4 业务逻辑

| 位置 | 内容 | 禁止操作 |
|---|---|---|
| 经验值登录积分 | 当天仅计 1 次登录经验 | 禁止改成每次登录都给 |
| 站内信联系人 | 全部活跃用户可见 | 禁止限制联系人范围 |
| 美文审核 | 学生上传 pending、教师/超管直接 approved | 禁止改审核流 |
| BigInt 转换 | `Number(r.lastInsertRowid)` | 禁止删除（否则 JSON 序列化报错） |
| 路由顺序 | 具体路由在通配路由前 | 禁止调整顺序（否则被 `/:id` 吞掉） |

### 6.5 墨金主题与液态玻璃（v3.0.0 新增）

| 位置 | 内容 | 禁止操作 |
|---|---|---|
| `src/styles/main.css` 经典档 `:root` | 经典暖橘主题变量 | 禁止修改（像素级不动，自 v1.0 基线） |
| `src/styles/main.css` `.zg-inkgold` / `.zg-inkgold-dark` | 墨金双档作用域 | 禁止把墨金样式写成全局 scoped 强加进经典（"一锅端"） |
| `src/styles/main.css` 深档变量块 | `html.zg-inkgold.zg-inkgold-dark`（特异性 0,2,1） | 禁止让深档特异性低于浅档（否则深底深字不可读，Bug17） |
| 墨金玻璃三级材质 | L1 0.08 / L2 0.10 / L3 0.12 + 亮边 0.6~0.7 | 禁止压到 0.35 以上做成"白瓷不透光" |
| 静态面板 `--zg-rim` | `inset 0 0 0 1px` 发丝金边 | 禁止使用（矩形界限根因，必须移除） |
| `:focus-visible` 选择器 | 须排除 `.el-input__wrapper` 等输入框类 | 禁止让输入框出现金色直角矩形边框（Bug14） |
| `public/fonts/noto-serif-sc-*.woff2` | 自托管衬线字体 | 禁止改回 Google Fonts CDN 依赖 |
| `public/bg/inkgold-paper*.svg` | 主题背景图 | 禁止删除（玻璃需透出背景） |

### 6.6 标注方式

新增的"禁止修改"逻辑，建议在代码中加注释标注：

```typescript
// ⚠️ 【禁止修改】BigInt 序列化修复，删除会导致评论接口 500
return { id: Number(r.lastInsertRowid), ... }

// ⚠️ 【禁止删除】路由顺序：具体路由必须在 /:id 之前，否则被通配吞掉
app.get('/api/articles/pending-student', auth, ...)
app.get('/api/articles/:id', auth, ...)
```

---

## 七、测试要求

### 7.1 发布前必测清单

每次改代码发布前，**必须**完成以下测试，不得只跑接口脚本就声称完成：

#### （1）三角色测试

分别用三个角色登录，把改动涉及的功能各操作一遍：

| 角色 | 测试账号 | 重点验证 |
|---|---|---|
| 超级管理员 | `admin` / `admin123456` | 用户管理、功能开关、经验规则、审核、全学科 |
| 教师 | （测试教师账号） | 本学科美文/资料/题库/成绩发布、不能访问用户管理 |
| 学生 | （测试学生账号） | 发美文（待审核）、上传资料（待审核）、答题、查成绩、站内信 |

**权限隔离验证**（教师不应能访问）：
- `GET /api/users` → 应返回 403
- `PUT /api/settings/feature_flags` → 应返回 403
- 写经验规则 → 应返回 403
- 删除用户 → 应返回 403

#### （2）大文件上传测试

- **必须**测试 1MB 以上的文件上传（不能只测 10KB 小文件）。
- 验证上传成功后文件可在列表查看/下载。
- 验证图片能在页面正常显示（公开图片免登录直出，绝对地址 `https://api.xkzg.dpdns.org/api/file/{id}`）。

#### （3）美文审核流程测试

- 学生发文 → 状态 `pending` → 学生自己列表可见"待审核"标签
- 超管/教师审核通过 → 状态 `approved` → 全员可见
- 审核通过后经验加给**原作者**（非审核人）
- 教师代发 → 学生确认发布流程（`pending_student` → `student-approve` → `pending`）

#### （4）构建验证

```bash
npm run build
# 必须无 TypeScript 类型错误，无构建失败
```

#### （5）生产验证

发布后**必须**自己打开 https://xkzg.de5.net 验证，不要直接说"改好了"。

### 7.2 回归测试脚本

项目提供回归验证脚本（可复用）：

- `/data/user/work/full_verify_9bugs_v2.py` — Bug9 回归验证（10/10 全通过）
- 每次发版后建议执行一次回归，确保已修复 Bug 未被改回。

### 7.3 测试不通过的处置

- 测试不通过**禁止**标记任务完成。
- 遇到阻塞问题，创建新任务描述需要解决的内容。
- 禁止为了通过测试而临时绕过/注释掉防御逻辑。

---

## 附：维护者自查清单

每次提交 PR 前，逐项确认：

- [ ] 已阅读交接文档第 7、10、15 章
- [ ] 改动只涉及必要文件，无顺手重构
- [ ] el-upload 使用 `:http-request`，未用 `:before-upload`
- [ ] 大文件（>100KB）走 Supabase 直传
- [ ] 角色名未修改
- [ ] 未删除任何已修复 Bug 的防御逻辑
- [ ] 未提交 `.env` / `*.db` / 密钥
- [ ] `npm run build` 通过
- [ ] 三角色测试通过
- [ ] 大文件上传测试通过
- [ ] 提交信息符合规范
- [ ] 如改了 `worker-api.ts`，已提醒手动 `wrangler deploy`
