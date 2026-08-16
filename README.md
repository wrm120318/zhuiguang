# 追光 · 学科共享平台（zhuiguang）

> 中学校园师生学科学习共享站 —— 美文共赏、资料共享、题库自测、单题训练、成绩查询、站内信、经验值系统，一站式校园学科学习社区。
>
> 全免费、零绑卡、全云端无服务器架构，70 人并发轻松扛住。

| 字段 | 值 |
|---|---|
| 项目中文名 | 追光 · 学科共享平台 |
| 项目英文名 | zhuiguang |
| 用户访问域名 | https://xkzg.de5.net |
| 后端 API 域名 | https://api.xkzg.de5.net |
| GitHub 仓库 | https://github.com/wrm120318/zhuiguang |
| 项目类型 | 中学校园师生学科学习共享站 |
| 服务人群 | 中学教师（6-10 人）+ 学生（50-60 人，峰值并发约 65） |
| 默认超管账号 | `admin` / `admin123456` |
| 开源协议 | MIT |
| 当前版本 | v2.1.19（Cloudflare Workers + D1 无服务器架构，弹窗样式修复 + 文档完善） |

---

## 目录

- [核心功能清单](#核心功能清单)
- [技术架构总览](#技术架构总览)
- [快速开始指南](#快速开始指南)
- [部署步骤概要](#部署步骤概要)
- [项目结构说明](#项目结构说明)
- [当前进度](#当前进度)
- [重要约束和规则](#重要约束和规则)
- [仓库与云端文件夹对应关系](#仓库与云端文件夹对应关系)

---

## 核心功能清单

| 模块 | 功能说明 | 适用角色 |
|---|---|---|
| 美文共享 | 师生发布学科美文，支持富文本/图片/封面/标签，含审核流程与学生确认发布机制 | 全部角色 |
| 资料共享 | 学科资料上传下载，支持分类/标签/收藏/点赞，大文件前端直传 Supabase | 全部角色 |
| 题库自测 | 教师创建测验（单选/多选/判断），学生答题，自动/手动批改，成绩报告 | 教师建题、学生作答 |
| 单题训练 | 学科题目池随机抽题练习，即时反馈对错，教师批阅评语 | 全部角色 |
| 单题训练记录 | 学生查看自己的历史训练记录（含得分/评语/时间），超管/教师按题目查看全班统计（正确率/待批/得分分布） | 学生看自己，教师/超管看全班 |
| 成绩查询 | 查询任务（教师发布成绩表），学生凭学号/姓名查询，支持导出 Excel | 教师发布、学生查询 |
| 站内信 | 师生互发私信，支持附件，未读提醒，联系人列表含全部活跃用户 | 全部角色 |
| 经验值系统 | 登录/发文/答题/审核等行为获得经验，自动升级，排行榜展示 | 全部角色 |
| 班级学科管理 | 班级与学科维护，班级成员分配，学科模块/公告配置，教师任教学科绑定 | 超管/教师 |
| 公告与指南 | 站点公告、使用指南页面，支持置顶与富文本 | 超管发布、全员查看 |
| 主题切换 | 多主题配色，后台可配置主题参数 | 超管配置、全员使用 |
| 功能开关 | 后台可视化管理自助注册等功能开关 | 超管 |
| 用户管理 | 用户增删改查、重置密码、启用/禁用账号、角色分配 | 超管 |

### 角色权限体系

项目采用三角色体系，角色名为固定字符串，**禁止修改**：

| 角色 | 角色名（代码常量） | 权限范围 |
|---|---|---|
| 超级管理员 | `SUPER_ADMIN` | 全部权限：用户管理、功能开关、经验规则、主题配置、所有学科与班级、审核 |
| 教师 | `TEACHER` | 本学科管理、发布美文/资料/题库/成绩，无用户管理/功能开关/经验设置/删用户权限 |
| 学生 | `STUDENT` | 发布美文（待审核）、上传资料（待审核）、答题、查询成绩、站内信、查看内容 |

---

## 技术架构总览

项目已从早期的「Pinggy SSH 隧道 + 本地 Node.js Express」架构迁移至 Cloudflare 无服务器架构，彻底告别隧道、零绑卡、全球 CDN 秒开、永不休眠。

### 架构图

```
用户浏览器访问: https://xkzg.de5.net
        |
        v
+---------------------------+     前端静态资源（Vue 3 SPA）
|   Cloudflare Pages        |     构建产物 dist/，全球 CDN
|   (Vue 3 + Element Plus)  |     SPA fallback，刷新不 404
+---------------------------+
        |
        | API 请求（同源模式：/api/xxx → Worker）
        v
+---------------------------+     后端 API（Hono 框架，136+ 路由）
|   Cloudflare Workers      |     worker-api.ts 部署
|   (Hono + JWT Auth)       |     全球边缘运行，10 万请求/天免费
+---------------------------+
        |               |
        v               v
+-----------+   +-------------------+
| Cloudflare|   |  Supabase Storage |
|   D1      |   |  (文件存储)        |
| (数据库)  |   |  前端直传 presign   |
| 23 张表   |   |  >100KB 直传       |
+-----------+   +-------------------+
```

### 技术栈

| 层级 | 技术 | 说明 |
|---|---|---|
| 前端框架 | Vue 3 + Vue Router + Pinia | 组合式 API，状态管理 |
| UI 组件库 | Element Plus | 按需自动导入（unplugin-auto-import / unplugin-vue-components） |
| 构建工具 | Vite 5 | 生产构建输出至 dist/ |
| 图表 | ECharts 5 | 排行榜、统计图表 |
| Markdown | marked | 美文/指南富文本渲染 |
| Excel | xlsx | 成绩导入导出 |
| 后端框架 | Hono 4 | Cloudflare Workers 原生，轻量高效 |
| 后端运行时 | Cloudflare Workers | 无服务器，边缘计算，nodejs_compat |
| 数据库 | Cloudflare D1 | SQLite 兼容，serverless，免费额度充足 |
| 文件存储 | Supabase Storage | 前端直传 presign URL，service_role 写入 |
| 认证 | JWT（jsonwebtoken）+ bcryptjs | Bearer Token，7 天过期 |
| 前端部署 | Cloudflare Pages | 静态托管，全球 CDN，自定义域名 |
| 后端部署 | Cloudflare Workers | `npx wrangler deploy`，自定义域名绑定 |

### 数据库（Cloudflare D1）

数据库共 **23 张表**，建表脚本见 `schema.sql`：

| # | 表名 | 用途 |
|---|---|---|
| 1 | users | 用户表（账号、密码哈希、角色、经验值、等级、状态） |
| 2 | classes | 班级表 |
| 3 | class_members | 班级成员表（学生/教师与班级、学科关联） |
| 4 | subjects | 学科表（名称、图标、颜色、模块配置、公告） |
| 5 | articles | 美文表（标题、内容、封面、图片、标签、状态、点赞、浏览） |
| 6 | resources | 资源表（文件名、类型、大小、路径、分类、下载量） |
| 7 | query_tasks | 查询任务表（成绩查询任务配置） |
| 8 | query_rows | 查询行表（成绩数据行） |
| 9 | exp_logs | 经验日志表（用户经验变动记录） |
| 10 | notices | 通知表（站内通知） |
| 11 | pages | 通用页面表（公告、指南等富文本页面） |
| 12 | page_comments | 页面评论表 |
| 13 | messages | 站内信表（私信、附件、已读状态） |
| 14 | quizzes | 题库表（测验配置） |
| 15 | quiz_questions | 题目表（题型、内容、选项、答案、分值） |
| 16 | quiz_submissions | 提交记录表（答卷、得分、批改状态） |
| 17 | subject_questions | 学科题目池（单题训练用） |
| 18 | practice_submissions | 单题训练提交记录 |
| 19 | likes_map | 点赞表（用户-目标类型-目标 ID 唯一） |
| 20 | article_comments | 美文评论表 |
| 21 | feature_flags | 功能开关表（KV 结构，如注册开关） |
| 22 | themes | 主题表（配色配置） |
| 23 | settings | 全局设置表（KV 结构） |

---

## 快速开始指南

### 环境要求

- Node.js >= 20.0.0
- npm（随 Node 安装）

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/wrm120318/zhuiguang.git
cd zhuiguang

# 2. 安装依赖
npm install

# 3. 复制环境变量模板并填写（本地开发可不填云端配置，用本地 SQLite）
cp .env.example .env

# 4. 启动开发服务器（前后端同时启动）
npm run dev
#   后端运行于 http://localhost:3001
#   前端运行于 http://localhost:5173（API 请求代理到 3001）

# 5. 浏览器打开 http://localhost:5173
#    默认超管账号：admin / admin123456
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时启动后端（tsx watch）+ 前端（vite），本地开发用 |
| `npm run server` | 仅启动后端开发服务器（热重载） |
| `npm run build` | 构建前端生产包到 dist/（vue-tsc 类型检查 + vite build） |
| `npm run preview` | 构建后以生产模式启动 |
| `npm start` | 以生产模式启动后端（server/index.ts） |
| `npm run deploy` | 构建 + 部署到 Cloudflare Workers |

### 本地数据库

本地开发使用 SQLite（`server/local.db`），首次运行后端会自动建表并写入种子数据（超管账号、初始班级、学科、主题）。

---

## 部署步骤概要

云端部署分前端（Cloudflare Pages）和后端（Cloudflare Workers + D1）两部分，全程零绑卡。

### 第一步：创建 D1 数据库

```bash
npx wrangler d1 create zhuiguang-db
# 将返回的 database_id 填入 wrangler.toml
```

### 第二步：建表 + 迁移数据

```bash
# 建表（23 张表 + 索引）
npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql

# 从本地 SQLite 迁移数据到 D1（如已有存量数据）
bash scripts/migrate-to-d1.sh

# 验证
npx wrangler d1 execute zhuiguang-db --remote --command="SELECT COUNT(*) FROM users"
```

### 第三步：配置环境变量

编辑 `wrangler.toml`，填写 Supabase 配置（JWT_SECRET、SUPABASE_URL、SUPABASE_SERVICE_KEY、SUPABASE_BUCKET）。这些值可从本地 `.env` 文件获取。

### 第四步：部署后端 Worker（需手动执行，Pages 不会自动部署 Worker）

```bash
cd /workspace
source .env
npx wrangler deploy
# 输出 Worker URL：https://zhuiguang-api.<子域名>.workers.dev
```

> **注意**：`source .env` 加载 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 后，`wrangler deploy` 才能正常工作。

### 第五步：部署前端到 Cloudflare Pages

1. 在 Cloudflare Pages 创建项目，连接 GitHub 仓库 `wrm120318/zhuiguang`
2. 构建命令：`npm run build`
3. 输出目录：`dist`
4. 绑定自定义域名 `xkzg.de5.net`

> Git push 到 main 分支后 Pages 会自动构建，无需手动操作。

### 第六步：验证

访问 https://xkzg.de5.net，使用 `admin / admin123456` 登录，确认各功能正常。

---

## 项目结构说明

```
zhuiguang/
├── src/                          # 前端源码（Vue 3）
│   ├── api/                      # API 请求封装
│   │   ├── http.ts               # axios 实例，同源模式（/api/xxx）
│   │   └── index.ts              # API 接口定义
│   ├── components/               # 公共组件（NavBar、MobileTabBar）
│   ├── layouts/                  # 布局组件（AdminLayout）
│   ├── router/                   # Vue Router 路由配置
│   ├── store/                    # Pinia 状态（user/data/settings/theme）
│   ├── styles/                   # 全局样式
│   ├── types/                    # TypeScript 类型定义
│   ├── utils/                    # 工具函数（helpers、markdown）
│   ├── views/                    # 页面视图
│   │   ├── admin/                # 管理后台页面（审核、用户、学科、班级等）
│   │   ├── quiz/                 # 题库相关页面
│   │   └── ...                   # 其他页面（首页、登录、个人资料等）
│   ├── App.vue
│   └── main.ts                   # 前端入口
├── server/                       # 本地后端（Express，仅本地开发用）
│   ├── index.ts                  # Express 服务入口
│   ├── auth.ts / db.ts / helpers.ts / storage.ts
│   └── local.db                  # 本地 SQLite 数据库（不入库）
├── worker-api.ts                 # Cloudflare Workers 后端（Hono，生产用，136 路由）
├── schema.sql                    # D1 完整建表脚本（23 张表 + 索引）
├── wrangler.toml                 # Cloudflare Workers 配置（D1 binding + 环境变量）
├── scripts/                      # 运维脚本
│   ├── migrate-to-d1.sh          # SQLite → D1 数据迁移
│   └── backup-sqlite.sh          # SQLite 备份
├── public/                       # 静态资源（_headers、_redirects）
├── dist/                         # 前端构建产物（部署到 Cloudflare Pages）
├── index.html                    # HTML 入口
├── vite.config.ts                # Vite 配置（代理、自动导入）
├── package.json                  # 依赖与脚本
├── tsconfig.json
├── .env.example                  # 环境变量模板
├── .gitignore
├── README.md                     # 本文件
├── CONTRIBUTING.md               # 开发规范
├── CHANGELOG.md                  # 版本日志
├── FAQ.md                        # 常见问题
├── DEPLOY_CHECKLIST.md           # 部署检查清单
└── LICENSE                       # MIT 协议
```

---

## 当前进度

### 已完成

- 全部核心功能模块上线运行（美文、资料、题库、单题训练、成绩查询、站内信、经验值、班级学科管理）
  - 单题训练记录管理：学生查看自己的训练记录（含得分/评语/时间），教师/超管按题目查看全班统计（正确率/待批/得分分布/作答详情），教师可在线批改主观题（打分/评语/删除记录）
- 三角色权限体系完整（SUPER_ADMIN / TEACHER / STUDENT）
- 已迁移至 Cloudflare Workers + D1 + Pages 无服务器架构（v2.0.0）
- 文件上传前端直传 Supabase presign URL，大文件不走后端
- 美文审核流程（含学生确认发布机制）完整闭环
- 经验值系统（登录每日仅计 1 次、发文、审核、答题等）
- 站内信全量用户联系人列表
- 功能开关后台管理（自助注册开关等）
- 多主题切换
- Bug9 大修复全部完成并回归验证（详见 CHANGELOG v1.1.0）
- 本地 → D1 数据迁移脚本
- 全套交接文档与运维脚本
- 主题发布全局生效修复（v2.1.7+）
- Markdown 编辑器支持（v2.1.12+）
- Markdown 空格保留修复（v2.1.13+）
- 弹窗关闭按钮统一为极简线条样式（v2.1.14-v2.1.18）
- 文档全面完善：所有 md 文件和 txt 提示词同步更新，域名统一、版本号一致（v2.1.19）

### 架构演进

| 版本 | 架构 | 状态 |
|---|---|---|
| v1.0.0 | Pinggy SSH 隧道 + 本地 Node.js Express + SQLite | 已废弃 |
| v1.1.0 | 同上 + Bug9 修复 | 已废弃 |
| v1.2.0 | Worker v5 双路兜底 + start-all 依赖加固 | 已废弃 |
| v2.0.0 | Cloudflare Workers + D1 + Pages + Supabase | 已上线 |
| v2.1.0 | 单题训练按题维度统计 + 训练记录管理 | 已上线 |
| v2.1.1 | 单题训练教师批改模式补全（BUG-22修复） | 已上线 |
| v2.1.7 | 主题发布全局生效修复 | 已上线 |
| v2.1.12 | Markdown 编辑器支持 | 已上线 |
| v2.1.13 | Markdown 空格保留修复 | 已上线 |
| v2.1.14-v2.1.18 | 弹窗关闭按钮统一修复 | 已上线 |
| v2.1.19 | 文档全面完善 + 域名统一 + 版本同步 | 已上线（当前） |

---

## 重要约束和规则

以下规则为项目铁律，源自实际踩坑经验，**务必遵守**：

### 1. 全免费、不绑卡

所有云服务必须使用免费额度，禁止引入需要绑卡/充值的服务。当前架构（Cloudflare + Supabase）全部零绑卡。

### 2. el-upload 上传组件

- 必须使用 `:http-request="customRequest"` 自定义上传
- **禁止**使用 `:before-upload`（异步上传失败会被静默吞掉，用户看不到任何反应）

### 3. 文件上传架构（>100KB 直传）

- 所有 **>100KB** 的文件，必须**前端直传 Supabase presign URL**，不走后端、不走隧道
- **禁止**改回 `POST /api/upload/file` multipart 方式
- 原因：早期隧道对 100KB 以上文件直接报错；保留此架构确保大文件稳定上传

### 4. 角色名固定

- `SUPER_ADMIN` / `TEACHER` / `STUDENT` 三个角色名为固定字符串
- **禁止**改名、**禁止**新增角色（除非业务明确需要）
- 这三个字符串在项目数百处做精确匹配，改动会导致全站崩溃

### 5. 禁止随意更换技术栈

- **禁止**换部署平台、换隧道工具、换数据库、换存储服务
- **禁止**升级依赖版本（除非证明不升级就跑不起来）
- **禁止**重构、重写架构、"顺手优化代码风格"
- 涉及架构变更的需求，须先出评估报告经项目负责人确认

### 6. "它能跑"就是最高标准

项目已跑通、能用，所有坑都踩过、所有 Bug 都修过。维护者定位是**维护者而非重写者**，不要为技术优雅引入新 Bug。

### 7. 经验值登录积分

同一天同一用户登录 N 次，只计 1 次经验。**禁止**改成每次登录都给。

### 8. 站内信联系人

普通学生也能看到全部活跃用户（除自己），可主动发消息给任何人。**禁止**限制为"只能给超管发"或"只能看聊过的人"。

### 9. 审核/可见性规则

- 超管/教师上传 → 直接 `approved`，立刻显示
- 学生上传 → 状态 `pending` 等待审核
- 学生自己的列表必须能看到自己的 `pending`（"待审核"标签）

### 10. 已修复 Bug 不得改回

详见 `交接文档.md` 第 10 章和 `CHANGELOG.md`。新维护者改代码前务必先读交接文档，避免把已修好的 Bug 改回去。

---

## 仓库与云端文件夹对应关系

| 本地路径 | 云端服务 | 部署方式 | 说明 |
|---|---|---|---|
| `dist/` | Cloudflare Pages | Git 连接仓库自动构建 | 前端生产包，构建命令 `npm run build`，输出目录 `dist` |
| `worker-api.ts` | Cloudflare Workers | `npx wrangler deploy` | 后端 API（Hono，136+ 路由） |
| `schema.sql` | Cloudflare D1 | `npx wrangler d1 execute --file=schema.sql` | 建表脚本（23 张表 + 索引） |
| `wrangler.toml` | Cloudflare Workers | 配置文件（不单独部署） | D1 binding + 环境变量 |
| `public/_headers` `public/_redirects` | Cloudflare Pages | 随构建部署 | CDN 头部与 SPA fallback 重定向 |
| `server/` | （本地开发用） | 不部署到云端 | 本地 Express 后端，生产已迁移至 Worker |
| `server/local.db` | 不上传 | .gitignore 排除 | 本地 SQLite，仅本地开发用 |
| `.env` | 不上传 | .gitignore 排除 | 环境变量（密钥），云端在 wrangler.toml 或 Dashboard 配置 |
| 文件存储 | Supabase Storage | 前端直传 presign URL | Bucket: `zhuiguang`，public 读取 |
| 数据库 | Cloudflare D1 | `zhuiguang-db` | database_id 见 wrangler.toml |

### 域名与访问

| 用途 | 地址 |
|---|---|
| 用户访问 | https://xkzg.de5.net |
| 前端 | Cloudflare Pages 绑定 `xkzg.de5.net` |
| 后端 API | Cloudflare Workers（`zhuiguang-api`），同源模式（`/api/xxx`） |
| Supabase | https://njwkkinzgmwzyfifagwl.supabase.co（Bucket: `zhuiguang`） |

---

## 许可证

本项目采用 [MIT License](LICENSE) 开源协议。

---

## 相关文档

| 文档 | 说明 |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发规范、分支管理、提交标准、测试要求 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新日志 |
| [FAQ.md](FAQ.md) | 高频问题问答库 |
| [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) | 部署检查清单 |
| [工作日志_追光学科共享平台.md](工作日志_追光学科共享平台.md) | 开发运维工作日志 |
| [开发工作日志_追光平台.md](开发工作日志_追光平台.md) | 逐条开发操作记录 |
| [交接文档.md](交接文档.md) | 完整交接文档（凭证、架构、Bug 清单、运维） |
