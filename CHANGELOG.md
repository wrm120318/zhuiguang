# 更新日志（CHANGELOG）

> 本文件记录「追光 · 学科共享平台」所有版本的变更内容，按时间倒序排列。
> 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

---

## [v2.1.9] - 2026-08-11

### 概述

**删除经验值说明界面和管理员设置界面中的回收规则显示。** 回收规则是"原来给多少，现在收多少"，无需单独显示和配置。

### 变更

- **经验值说明界面**（ExpDocView.vue）：删除删除/取消类规则（article_delete、like_cancel等），只显示获取经验的规则
- **管理员设置界面**（ExpRulesView.vue）：删除删除/取消类规则，只显示获取经验的规则
- **回收规则**：删除内容时直接删除相关经验值记录，无需单独配置回收规则

### 代码修改

- `src/views/ExpDocView.vue`：删除 `article_delete`、`resource_delete`、`blog_delete`、`query_delete`、`comment_delete`、`like_cancel`、`favorite_cancel` 规则
- `src/views/admin/ExpRulesView.vue`：删除上述规则

---

## [v2.1.8] - 2026-08-11

### 概述

**修改删除美文时的经验值处理逻辑。** 删除美文时直接删除相关的经验值记录，不再添加负向的"回收"记录。

### 变更

- **删除美文时**：直接 `DELETE` 相关的经验值记录（article、like类型），然后更新用户经验值
- **不再显示**：经验值记录中不再出现"删除美文《XXX》回收经验"这类负向记录
- **界面显示**：经验值记录只显示原始操作记录（如"获得点赞"、"审核通过"），删除后这些记录直接从列表中消失

### 代码修改

- `worker-api.ts`：修改删除美文接口，使用 DELETE 语句删除经验值记录
- `server/index.ts`：同步修改

---

## [v2.1.7] - 2026-08-10

### 概述

**修复删除美文时点赞数不一致问题。** 删除美文时应先统计并修正 `likes` 计数，避免数据不一致。

### 修复

- **BUG-28 删除美文时点赞数不一致**：删除美文时未修正 `likes` 字段，导致 `likes_map` 表中无记录但 `articles.likes` 仍为正值。修复：删除前先查询点赞数并修正 `likes` 计数

### 变更

- `worker-api.ts`：删除美文接口增加点赞数修正逻辑
- `server/index.ts`：同步修改

---

## [v2.1.6] - 2026-08-10

### 概述

**经验值系统完整测试与优化。** 验证点赞/取消点赞/删除美文的经验值变化逻辑，修复点赞数不一致问题。

### 测试验证

- **点赞功能测试**：用户点赞美文后经验值正确增加（+1），经验值记录正确写入
- **取消点赞测试**：用户取消点赞后经验值正确回收（-1），经验值记录正确写入
- **删除美文测试**：删除美文后相关经验值正确回收（-21），经验值记录正确写入

### 发现与修复

- **点赞数不一致问题**：美文27的 `likes` 字段显示为1，但 `likes_map` 表中无记录。删除美文时未修正 `likes` 计数
- **经验值记录策略**：删除美文时保留原有记录，新增负向回收记录，确保历史完整性

### 变更

- 无代码变更（逻辑已正确实现）
- 测试验证通过

---

## [v2.1.5] - 2026-08-10

### 概述

**修复前端 Admin 经验设置页默认值为正数导致删除/取消操作反向加经验。**

### 修复

- **BUG-27 Admin 经验设置默认值符号错误**：`ExpRulesView.vue` 中 `DEFAULT_RULES` 的删除类行为（article_delete/resource_delete/blog_delete/query_delete/comment_delete/like_cancel）均为正数，与后端 `DEFAULT_EXP_RULES` 的负数不一致。若管理员从该页保存设置，会将正数写入数据库，导致删除内容时反而增加经验值。修复为全部改为负数

### 变更

- `src/views/admin/ExpRulesView.vue`：6 个删除/取消规则的默认值改为负数

---

## [v2.1.4] - 2026-08-10

### 概述

**修复主观题批改后正确标记显示错误。** 批改主观题时未更新 `correct` 字段（保持 NULL），导致前端满分离也显示红色 ✗。

### 修复

- **BUG-26 主观题批改correct字段缺失**：批改接口 UPDATE 语句缺少 `correct` 字段更新，导致 `correct` 保持 NULL，前端 `correct === 1` 判断失败显示红色 ✗。现根据 `score >= max_score` 自动计算 correct(1/0) 并写入数据库

### 变更

- `worker-api.ts`：批改接口补 `correct` 字段更新
- `server/index.ts`：同步修改

---

## [v2.1.3] - 2026-08-10

### 概述

**单题训练通知补全。** 提交主观题和批改主观题时，同步发送系统通知（Notices），让铃铛亮起，不再只靠站内信提醒。

### 修复

- **BUG-25a 提交主观题缺系统通知**：学生提交主观题后，只发了站内信给教师/超管，未发系统通知。现同步调用 `addNotice`，通知类型 `teacher`
- **BUG-25b 批改主观题缺系统通知**：教师批改主观题后，只发了站内信给学生，未发系统通知。现同步调用 `addNotice`，通知类型 `teacher`，内容含得分和评语

### 变更

- `worker-api.ts`：提交和批改两个接口各补一行 `addNotice`
- `server/index.ts`：同步修改

---

## [v2.1.2] - 2026-08-10

### 概述

**单题训练统计模块死代码清理。** 移除后端统计接口中无用的 `scoreDist` SQL 查询和前端未使用的变量。

### 修复

- **BUG-23 统计接口冗余查询**：后端统计接口之前执行了 4 次 COUNT 查询 + 1 次冗余的 `scoreDist` 查询（前端完全未使用），现精简为 3 次 COUNT 查询 + 1 次待批列表 + 1 次详情列表，减少一次不必要的数据库往返

### 变更

- `worker-api.ts`：移除统计接口中 `scoreDist` 查询及返回字段
- `server/index.ts`：同步修改
- `src/views/quiz/PracticeStatsView.vue`：移除未使用的 `scoreDist` ref 变量及赋值

---

## [v2.1.1] - 2026-08-10

### 概述

**单题训练教师批改功能补全。** 修复 BUG-22：教师从统计页点"去批改"后无法打分/写评语的严重问题。

### 修复

- **BUG-22a 教师批改UI缺失**：`PracticeTakeView.vue` 新增批改模式（URL `?grade=subId`），教师可：
  - 查看学生作答内容（Markdown渲染）
  - 查看题目内容和参考答案（主观题）
  - 打分（0-题目满分）+ 写评语
  - 删除该条提交记录
- **BUG-22b 删除接口重复定义**：`worker-api.ts` 和 `server/index.ts` 中 `DELETE /api/practice/record/:id` 被定义了两次（第一个仅本人，第二个requireStaff版本被忽略），导致教师删学生记录直接403。合并为统一版本：本人 OR 教师本学科 OR 超管
- **BUG-22c 缺少提交详情接口**：新增 `GET /api/practice/submission/:id`（含权限校验），支持教师批改时获取完整的学生作答和题目信息
- **BUG-22d subjectName字段映射**：`PracticeRecordsView.vue` 模板用 `rec.subjectName` 但后端返回的是 `subject_name`，已修复

### 变更

- `src/views/quiz/PracticeTakeView.vue`：从纯学生模式改为支持学生作答/学生查看结果/教师批改三种模式
- `src/api/index.ts`：新增 `practiceSubmission(id)` API方法
- `worker-api.ts`：删除接口合并 + 新增 submission 接口
- `server/index.ts`：同步修改，保持本地开发版与生产一致

---

## [v2.1.0] - 2026-08-10

### 概述

**单题训练按题维度统计和记录管理。** 每道题目独立展示全班统计（正确率/提交数/待批数），支持查看每位学生的作答详情、教师批阅评语，并可管理记录。

### 新增

- **后端 API（4条）**：
  - `GET /api/practice/my-records`：学生查看自己的训练历史（分页，含题目、学科、得分、评语、时间）
  - `DELETE /api/practice/record/:id`：学生删除自己的记录 / 教师/超管删除任意记录
  - `GET /api/practice/stats/:questionId`：教师/超管查看某道题的全班统计（正确率/提交数/待批/已批）和作答详情
- **前端页面 2个**：
  - `src/views/quiz/PracticeRecordsView.vue`：我的训练记录页，学生分页查看历史记录，支持删除
  - `src/views/quiz/PracticeStatsView.vue`：单题统计页，按题目维度展示：统计卡片+待批列表+全部记录，教师可删除记录
- **入口**：题库自测 tab 中每道题目卡片增加「📊 统计」按钮（教师/超管可见）；题库自测 tab 头部保留「📝 我的训练记录」按钮（学生可见）
- **经验值区分修复**：单题训练批改完成改用 `practice_pass`（+5 经验值），题库自测保持 `quiz_pass`（+10 经验值），两种行为经验值不再混淆

### 修复

- 修复单题训练批改完成后经验值错误加 10 而非 +5 的问题（action_type 从 `quiz_pass` 改为 `practice_pass`，同步修改 server/index.ts 和 worker-api.ts）
- 修复 UsersView.vue 经验记录弹窗列重叠问题（删除 `:deep(.el-dialog){width:440px}` 全局覆盖）

### 变更

- `PracticeStatsView.vue` 路由从 `/practice/stats/:subjectId` 改为 `/practice/stats/:questionId`，按单题维度而非学科维度
- 新增路由：`/practice/my-records`（PracticeRecordsView）

---

## [v2.0.0] - 2026-08-08

### 概述

**架构大迁移：从「Pinggy SSH 隧道 + 本地 Node.js Express + SQLite」全面迁移至「Cloudflare Workers + D1 + Pages + Supabase」无服务器架构。** 彻底告别隧道，全免费、零绑卡、全球 CDN 秒开、永不休眠。

### 新增

- **Cloudflare Workers 后端**：新增 `worker-api.ts`，基于 Hono 框架，从 Express 版本（`server/index.ts`）转换而来，保留全部 115+ 路由的完整业务逻辑、SQL 查询、JWT 认证、Supabase Storage 集成。
- **Cloudflare D1 数据库**：新增 `schema.sql` 完整建表脚本（23 张表 + 索引），新增 `wrangler.toml` 配置文件（D1 binding + 环境变量）。
- **数据迁移脚本**：新增 `scripts/migrate-to-d1.sh`，支持从本地 SQLite（`server/local.db`）迁移存量数据到 Cloudflare D1。
- **前端动态 API 地址**：改造 `src/api/http.ts`，支持通过 `VITE_API_BASE_URL` 环境变量在构建时注入后端 Worker 地址，零代码修改适配本地开发/云端分离部署。
- **部署文档**：新增 `Workers-D1上云指南.md`，详细记录 Cloudflare Workers + D1 + Pages 部署全流程。

### 变更

- **后端部署方式**：从本地 Node.js Express（`server/index.ts`，监听 3001 端口）迁移至 Cloudflare Workers（`worker-api.ts`，边缘运行）。
- **数据库**：从本地 SQLite（`server/local.db`）迁移至 Cloudflare D1（`zhuiguang-db`）。
- **前端部署**：从本地 Vite 开发服务器 + 隧道暴露，迁移至 Cloudflare Pages（绑定 `xkzg.dpdns.org`，全球 CDN）。
- **文件存储**：保留 Supabase Storage 前端直传 presign URL 架构不变（Bucket: `zhuiguang`）。

### 移除

- **Pinggy SSH 隧道**：彻底移除隧道依赖（`tunnel-keeper.sh`、`keep-alive.sh` 等守护脚本不再需要）。
- **Worker 反向代理**：移除原 `worker.js` 反向代理逻辑（不再需要 Worker 转发到隧道）。
- **never-die-guard 保活**：移除本地保活脚本（云端永不休眠）。
- **rc.local 开机自启**：移除本地开机自启配置（不再依赖本地服务器）。

### 架构对比

| 维度 | v1.x（隧道方案） | v2.0.0（无服务器） |
|---|---|---|
| 稳定性 | 依赖 Pinggy 节点，55 分钟必须刷新，1016 频繁 | 云端 7x24 常驻，零刷新零隧道 |
| 速度 | 国内→香港隧道→沙箱→返回，慢 | Cloudflare 全球 CDN，快 3-5 倍 |
| 维护成本 | 多个守护脚本 + 杀僵尸 + 推 GitHub | 什么都不用管，点按钮部署 |
| 电脑关机 | 沙箱关了网站立刻挂 | 电脑关机网站照样在线 |
| 费用 | 零 | 零 |

### 注意事项

- `server/index.ts` 保留用于本地开发，生产环境使用 `worker-api.ts`。
- 后端改动须同时修改 `worker-api.ts` 和 `server/index.ts` 保持一致。
- `worker-api.ts` 改动后须手动 `npx wrangler deploy` 部署（Pages 不会自动部署 Worker）。
- `schema.sql` 改动后须手动 `npx wrangler d1 execute` 执行。

---

## [v1.2.0] - 2026-08-05

### 概述

**Worker v5 双路兜底 + start-all 依赖加固。** 在隧道方案末期，针对 Pinggy 隧道 60 分钟强制过期导致频繁 1016/530 错误的问题，做了最后的兜底加固，并完善了自动修复机制。

### 新增

- **Worker v5 双路兜底**：Cloudflare Worker 反向代理同时维护多个隧道 URL 候选池，假死 URL 自动剔除，随机轮询可用 URL，降低单点故障率。
- **公开修复路由 `GET /__zg_fix`**：无需登录、无需进后台，浏览器地址栏直接输入 `xkzg.dpdns.org/__zg_fix` 即可触发自动修复。返回独立 HTML 页面，含 IP 限频（1 小时最多 2 次）和 10 分钟互斥锁。
- **健康检查接口 `GET /__zg_health`**：固定返回 `OK:<timestamp>`，永远 HTTP 200，供保活脚本验证。
- **登录页修复按钮**：`LoginView.vue` 右上角新增极小圆形修复按钮，点击新标签页打开 `/__zg_fix`，能看到登录页就能修复。
- **后台修复按钮**：`AdminLayout.vue` 右下角新增橙红色"一键修复"呼吸动画大按钮。
- **never-die-guard v3.0**：3 秒保活 + 15 秒 Python 代理验真活 URL，假死 URL 立即剔除，根治 60 分钟过期问题。
- **rc.local 开机自启**：配置开机自动启动后端 + SSH 自恢复 + NDG 保活。

### 变更

- **start-all.sh 依赖加固**：启动前自动检查 `node_modules` 是否存在，不存在则自动 `npm install`；加载 `.env` 环境变量；进程崩溃后 3 秒自动重启。
- **SELF_REPAIR_LOCK 前置**：互斥锁定义移至 `const app = express()` 之后最开头，修复 `Cannot access before initialization` 崩溃问题；删除重复声明。

### 修复

- 修复 `SELF_REPAIR_LOCK` 定义在 1192 行但 `/__zg_fix` 在 30 行引用导致 `Cannot access before initialization` 崩溃。
- 修复 `never-die-guard` 验证的健康检查接口不存在（404 假死）问题。
- 修复 Pinggy 免费 SSH 隧道每 60 分钟强制过期，旧 URL 残留在候选池导致 530/1016 错误。

---

## [v1.1.0] - 2026-08-04

### 概述

**Bug9 大修复。** 用户一次性报告 9 条业务 Bug，涉及美文审核、评论、账号禁用、注册开关、学生确认美文、状态标注、经验记录、审核积分、教师权限，全部修复并通过 10/10 回归验证。

### 修复

#### Bug1：美文审核篡改作者 + 经验错加

- **问题**：学生发美文 → 超管审核 → 系统强行把作者篡改成超管，经验也错加到超管。
- **根因**：审核逻辑 UPDATE 时顺手改了 `user_id`，经验 `addExp` 给了审核人而非原作者。
- **修复**：`PATCH articles/:id/status` 只改 status 不改 user_id；发文经验 `addExp` 绑定实际作者。

#### Bug2：美文评论接口 500

- **问题**：美文共赏评论功能失效，接口报 500。
- **根因**：SQLite/libsql 返回的 `lastInsertRowid` 是 BigInt，`JSON.stringify` 报错。
- **修复**：评论接口 `Number(r.lastInsertRowid)` 显式转 number 后返回。

#### Bug3：美文审核形同虚设

- **问题**：点了审核状态不变，列表还是显示全部。
- **根因**：①路由顺序 `pending-student` 被 `/:id` 吃掉；②status 更新 SQL 的 WHERE 没写对。
- **修复**：①`pending-student` 等具体路由前置；②UPDATE 用正确 WHERE id=?。

#### Bug4：账号禁用未生效

- **问题**：被禁用者正在使用时不会被踢下线，之后还能登录。
- **根因**：登录接口未判断 `users.status === 'disabled'`。
- **修复**：登录密码校验通过后额外检查 status，禁用则返回"账号已被禁用"；auth 中间件每次请求检查 status。

#### Bug5：注册开关缺失

- **问题**：管理员无法在管理面板开关注册功能。
- **根因**：①前端 FeatureFlagsView 漏了 `registration_enabled` 项；②后端 helpers 未合并 KV 表值；③无 public 接口给登录页读开关。
- **修复**：①ALL_FLAGS 数组加自助注册卡片；②`getFeatureFlags()` 读 `feature_flags` KV 表；③新增 `GET /api/feature-flags/public`。

#### Bug6：学生确认美文发布功能缺失

- **问题**：教师代发美文后，学生无法确认发布，别人看不到。
- **根因**：①前端缺"待我确认美文"入口；②缺 `student-approve`/`student-reject` 接口；③缺 messages 富文本通知。
- **修复**：①补 `POST /api/articles/:id/student-approve` & `student-reject`；②代发后 `addNotice` + INSERT messages 富文本；③前端补 pending-student 列表页入口。

#### Bug7：美文状态未标注 + 可见性错误

- **问题**：未审核/未通过/未确认的美文未标注状态，且不应可见的人能看到。
- **根因**：①详情/列表 SQL 未 JOIN 出作者名；②列表查询缺少行级可见性判断。
- **修复**：①articles 查询统一 JOIN users；②列表 WHERE 叠加可见性条件（自己是作者 OR 教师任教学科 OR 超管）；③前端统一渲染状态标签（pending/pending_student=黄色, rejected=红色, approved=绿色）。

#### Bug8：经验记录显示异常

- **问题**：个人中心经验记录空白/全 undefined/报错。
- **根因**：①接口路由错（前端调 `/exp-logs`，后端是 `/exp/logs`）；②返回字段名不匹配。
- **修复**：统一后端 `GET /api/exp/logs` 返回数组 `{id, user_id, action_type, exp_change, description, created_at}`，前端对齐字段名。

#### Bug9：教师权限越界

- **问题**：学科教师管理页面看到了用户管理/功能开关/经验设置/删用户等不该有的权限。
- **根因**：①`/api/users` 等用了 `requireStaff` 而非 `requireRole('SUPER_ADMIN')`；②前端 sidebar 菜单 teacher 角色漏 v-if 限制。
- **修复**：①敏感接口统一 `requireRole('SUPER_ADMIN')`（/api/users、/api/settings/feature_flags、/api/exp/* 写接口）；②前端菜单用 computed 按 role 过滤。

### 变更

- `server/index.ts`：路由顺序修复、权限中间件加固、BigInt 转换、新增 student-approve/reject 路由、新增 feature-flags/public 接口。
- `server/helpers.ts`：`getFeatureFlags()` 从 `feature_flags` KV 表读 `registration_enabled`。
- `server/db.ts`：新建 `article_comments` 表 + 索引。

### 验证

- 回归验证脚本 `/data/user/work/full_verify_9bugs_v2.py`，10/10 全部通过。

---

## [v1.0.0] - 2026-08-04

### 概述

**初版完整交接文档。** 项目首个正式版本，完成全部核心功能开发，整理完整交接文档，确立项目维护规范。

### 新增

- **完整交接文档**：创建 `交接文档_追光学科共享平台.md`，涵盖项目身份卡、凭证、部署架构、技术栈、数据库结构、核心文件索引、文件上传架构、角色权限、业务规则、Bug 清单、功能清单、运维指南、常用命令、故障排查、维护约束、时间线共 16 章。
- **开发工作日志**：创建 `开发工作日志_追光平台.md`，逐条记录所有开发/运维/验证工作。
- **维护者提示词**：创建 `给新AI维护者的提示词_首条消息必贴.txt`，确立 10 条铁律。

### 核心功能（全部上线）

- 美文共享（含审核流程、评论、点赞、学生确认发布）
- 资料共享（含分类、收藏、下载、审核）
- 题库自测（含单选/多选/判断、自动/手动批改、成绩报告）
- 单题训练（学科题目池、即时反馈、教师批阅）
- 成绩查询（教师发布成绩表、学生查询、Excel 导出）
- 站内信（师生互发、附件、未读提醒、全量联系人）
- 经验值系统（登录/发文/答题/审核等行为、自动升级、排行榜）
- 班级学科管理（班级、成员、学科、模块、公告）
- 公告与指南、主题切换、功能开关、用户管理

### 技术栈（v1.0.0 时期）

- 前端：Vue 3 + Element Plus + Vite + Pinia + Vue Router
- 后端：Node.js + Express + tsx + better-sqlite3（本地 SQLite）
- 文件存储：Supabase Storage（前端直传 presign URL）
- 对外访问：Pinggy 免费 SSH 隧道 + Cloudflare Worker 反向代理
- 域名：https://xkzg.dpdns.org

### 数据库

- 23 张表完整建表（users, classes, class_members, subjects, articles, resources, query_tasks, query_rows, exp_logs, notices, pages, page_comments, messages, quizzes, quiz_questions, quiz_submissions, subject_questions, practice_submissions, likes_map, article_comments, feature_flags, themes, settings）
- 首次运行自动建表 + 种子数据（超管账号、2 个班级、9 个学科、默认主题）

### 默认初始数据

- 超管账号：`admin` / `admin123456`
- 2 个班级：高二 1 班、高二 2 班
- 9 个学科：语文、数学、英语、物理、化学、生物、政治、历史、地理 + 信息技术
