# 更新日志（CHANGELOG）

> 本文件记录「追光 · 学科共享平台」所有版本的变更内容，按时间倒序排列。
> 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

---

## [v4.2.2] - 2026-08-29

> 通用 Markdown 富文本编辑器 + 美文/公告可多次编辑 + 统一渲染样式

### 新增功能

1. **【公共组件】`src/components/MarkdownEditor.vue`** — 全站通用富文本编辑器
   - 左侧 textarea + 顶部工具栏 + 右侧实时预览（marked + KaTeX + 8 类扩展）
   - 顶部 Tab：编辑 / 分屏 / 预览（默认分屏）
   - 工具栏：撤销/重做（Ctrl+Z/Shift+Z）、H1-H4、粗/斜/删除线/==高亮==/行内代码、列表/有序列表/待办/引用/表格/分割线、🖼图片（拖拽+粘贴上传）/🔗链接/🎬视频/📺B站/📄PDF/📎file:// 附件、$公式$/$$块公式$/@提及、20 表情
   - 快捷键：Ctrl+B 加粗、Ctrl+I 斜体、Ctrl+K 链接
   - 撤销/重做栈深度 100，光标保留在插入点
   - 全屏模式（fixed 覆盖全屏）
   - 拖拽上传 / 粘贴上传（图片自动入文）
   - 字数 + 行数实时统计
2. **【marked 扩展】`src/utils/marked-extensions.ts`** — CommonMark + 8 类扩展
   - **KaTeX 行内 `$...$` / 块级 `$$...$$`**：数学公式支持（CDN 注入 KaTeX CSS）
   - **`@[name](/user/uid)`**：用户提及，点击跳 `/profile?uid=...`，背景色块样式
   - **`==text==`**：文本高亮（黄色荧光笔效果）
   - **`![alt](url =100x100)`**：自定义图片尺寸
   - **`@`https://...a.mp4``**：视频嵌入（HTML5 `<video controls>`）
   - **`@[bilibili](BVxxx)`**：B 站嵌入（iframe 官方播放器）
   - **`@`https://...a.pdf``**：PDF 嵌入（iframe + 标题栏 + 兜底下载）
   - **`file://文件名`**：附件引用（蓝色链接样式，题目/比赛/训练中推荐用）
   - **HTML 白名单子集**：`details/summary/kbd/mark/sub/sup/ins/del/figure/figcaption`（其余标签自动过滤、`on*` 事件属性移除、`javascript:` 协议过滤）
3. **【新增 API】`PATCH /api/articles/:id`** — 美文可多次编辑
   - 权限：发布者本人 / 实际作者（代发美文的学生） / 超管 / 任教该学科教师
   - 可编辑字段：title / content / author / source / recommendation / cover / images / tags / category
   - 不可改：user_id / actual_user_id / status（仍走 auditArticle）
   - server/index.ts 同步实现
4. **【路由】新增编辑路径**
   - `/article/:id/edit`（编辑美文）→ ArticleEditView
   - `/announcements/:id/edit`（编辑公告）→ AnnouncementEditView
5. **【API】`api.updateArticle(id, data)`** — 前端调用方法
6. **【详情页编辑入口】**
   - ArticleView 详情页：作者本人 / 实际作者 / 超管 / 任教该学科教师 可见「✏️ 编辑美文」按钮
   - AnnouncementDetailView 详情页：超管可见「✏️ 编辑公告」按钮
7. **【CSS 增强】`src/styles/main.css` 末尾** — 207 行 `.markdown-body` 渲染样式
   - H1-H6 标题分级 + 装饰下划线、段落、列表、引用（左边竖线+背景色）、行内代码、代码块（深色背景）、表格（奇偶行色）、分割线（渐变）、图片
   - `mark.zg-highlight` 黄色荧光笔效果
   - `a.zg-mention` 蓝色色块链接
   - `a.zg-file-link` 附件链接（带📎图标）
   - `.zg-katex-inline` / `.zg-katex-block` 公式容器
   - `.zg-video-wrap` / `.zg-bili-wrap` / `.zg-bili-iframe` 视频嵌入
   - `.zg-pdf-wrap` / `.zg-pdf-head` / `.zg-pdf-iframe` PDF 嵌入
   - `details/summary/kbd/sub/sup/ins/figure/figcaption` HTML 白名单子集样式

### 改造（5 个编辑视图全部接入 MarkdownEditor）

| 文件 | 变更 |
|---|---|
| `src/views/ArticleEditView.vue` | textarea 拼字符串 + contenteditable → MarkdownEditor；新增代发作者下拉选择器（教师/超管可代发）；支持编辑/新建双模式；`/article/:id/edit` 拉取回填 |
| `src/views/AnnouncementEditView.vue` | textarea 拼字符串 → MarkdownEditor；新增全站/班级公告类型切换 + 班级下拉 + 置顶选项；支持编辑/新建双模式；`/announcements/:id/edit` 拉取回填（仅超管可编辑） |
| `src/views/BlogEditView.vue` | textarea 拼字符串 → MarkdownEditor；保留封面上传 + 附件列表 + 图片批量上传；支持编辑/新建双模式 |
| `src/views/admin/GuideEditView.vue` | **从拼 HTML 字符串（`<h2>`、`<details>` 直接拼）** → MarkdownEditor（最重大改造，HTML 字符串编辑器烂到必须改） |
| `src/views/SubjectForumEditView.vue` | contenteditable + execCommand → MarkdownEditor（保留话题标签 / 草稿自动保存 / 免审阈值提示 / 侧栏规则卡等业务逻辑） |

### 依赖

- 新增 `katex@0.16.11`（CDN 引入 CSS，npm 包提供 `renderToString`）
- `marked@18.x`（已有）支持自定义 extensions API

### 兼容性

- **老数据兼容**：marked 默认 HTML 透传，所以**老 HTML 数据（contenteditable 时代的美文/博客/论坛/公告）直接渲染仍然正常**——不会丢样式。
- **新数据**：用 MarkdownEditor 写 Markdown + HTML 子集 + 扩展语法，存库仍是源文本。
- **同时支持 Markdown 和 HTML 粘贴**：用户在编辑器粘贴 HTML，marked 透传；粘贴纯文本，marked 渲染 Markdown 语法。
- **统一渲染**：所有详情页（美文 / 公告 / 博客 / 论坛帖子 / 网站说明）都用 `renderMarkdown()` 渲染，**用户粘贴 HTML 也能渲染，Markdown 也能渲染**。

### Bug 修复（2026-08-29 补）

- **【编辑器】粘贴 HTML 被吞成纯文本**：`MarkdownEditor.vue` 的 `onPaste` 原只处理图片粘贴，富文本 HTML 被浏览器按 `text/plain` 脱标签写入，粘进来成了纯文本。现改为：① 图片文件优先（保留原粘贴上传）；② 若剪贴板含 `text/html`，用 `sanitizeHtml`（现有白名单）清洗后按 HTML 源码插入；③ 平凡包裹（单个 `<div>文字</div>` 且无其它标签）回落浏览器默认纯文本粘贴，避免误插。复用并导出 `marked-extensions.ts` 的 `sanitizeHtml`，避免重复白名单。
- **【论坛编辑】编辑帖子时误加载本地草稿、覆盖原帖**：`SubjectForumEditView.vue` 的 `onMounted` 在拉取原帖内容后无条件调用 `tryRestoreDraft()`，而 `tryRestoreDraft` 的编辑分支会先用 `useAutoSave.restoreDraft()` 把表单覆盖成本地草稿（即便用户点"放弃草稿"，`clear()` 只删 localStorage、并不还原表单），导致打开编辑页看到的是草稿而非原帖。`ArticleEditView` 同类流程是对的（编辑分支只 `loadForEdit()`、不恢复草稿）。修复：编辑模式分支直接跳过草稿恢复，始终以原帖内容为准；新建模式仍保留草稿恢复。`useAutoSave` 的 `restoreDraft()` 会直接改写表单且无"只检测不写入"接口，故采用"编辑模式不调用"的最小修复。
- **【题库报告】学生报告看不到单题得分**：`QuizReportView.vue` 学生个人报告每题头部只渲染了题目满分 `q.score`，从未渲染学生该题实际得分。后端 `my_report` 返回的 `submission.answers.graded[qid].score` 一直存在（客观题提交即自动评分、主观题教师批改后更新；教师批改视图 `QuizSubmissionsView.vue` 早已用同一字段），属纯前端漏渲染。修复：每题头部改为显示「本题 X 分 · 你的得分 Y 分」，并按对错/待批改着色（客观题对绿错红、主观题待批改/已得分用主题色）。

### 部署

- 后端：`wrangler deploy` → `https://zhuiguang-api.wangruiming-0318.workers.dev` v4.2.2 已部署
- 前端：`git push origin main` → Cloudflare Pages 自动 build 部署
- 验证：`npm run build` 通过（vue-tsc 类型检查 + vite 构建）
- 沙箱 curl 验证 PATCH /api/articles/:id 路由已生效

### 文件清单

**新增**：
- `src/components/MarkdownEditor.vue`（约 350 行）
- `src/utils/marked-extensions.ts`（约 230 行）

**修改**：
- `worker-api.ts`（+34 行：PATCH /api/articles/:id）
- `server/index.ts`（+33 行：同步 PATCH /api/articles/:id）
- `src/utils/markdown.ts`（+50 行：集成扩展 + 暴露 extractMentions）
- `src/api/index.ts`（+2 行：api.updateArticle）
- `src/router/index.ts`（+2 行：2 个新路由）
- `src/styles/main.css`（+207 行：markdown-body 渲染样式）
- `src/views/ArticleEditView.vue`（重写）
- `src/views/AnnouncementEditView.vue`（重写）
- `src/views/ArticleView.vue`（+3 行：编辑按钮）
- `src/views/AnnouncementDetailView.vue`（+7 行：编辑按钮）
- `src/views/BlogEditView.vue`（重写）
- `src/views/admin/GuideEditView.vue`（重写）
- `src/views/SubjectForumEditView.vue`（重写）
- `package.json` / `package-lock.json`（+katex）

---

## [v4.2.1] - 2026-08-28

> 通知中心：收到评论 / 点赞 → 自动入通知中心，可一键跳转到对应评论位置

### 新增
- **通知 type 区分**：`comment`（评论）/ `like`（点赞）两种专用 type，颜色与原有 `audit / query / teacher` 区分
- **通知跳转链接 `target_url`**：`notices` 表新增 `target_url` 字段（在线 ALTER 幂等），写入 `/article/{id}#comment-{cid}` 等深链
- **通知点击 → 跳转到对应评论位置**：点击通知项，标记已读 + 关闭抽屉 + 路由跳转 + 滚动到锚点
- **5 类入口的 comment/like 通知触发**（worker-api.ts + server/index.ts 同步）：
  - 美文点赞 / 美文主评论 / 美文子评论
  - 资料点赞（项目内**没有**资源评论功能，故无资料评论通知）
  - 博客点赞 / 论坛帖点赞 / 博客主评论 / 论坛帖主评论 / 博客子评论 / 论坛帖子评论
- **防刷策略**：
  - 自己点自己 / 自己评论自己的 → 不发通知
  - 子评论只通知被回复人（不通知作者）
- **前端锚点定位**：`CommentTree.vue` 每条评论加 `id="comment-{id}"`，列表容器加 `id="comment-area"`，跳转后 `scrollIntoView` 平滑滚动
- **30 秒轮询**：NavBar 通知抽屉 30s 自动拉取最新通知（已有）

### 数据库变更
```sql
ALTER TABLE notices ADD COLUMN target_url TEXT;
```
（在线 ALTER，幂等，不影响历史数据；schema.sql 同步加 `target_url` 字段）

### 验证
- `npm run build` 通过
- 沙箱 grep 验证：5 类入口（美文/资料/博客/论坛 点赞+评论）的 `addNotice` 触发全部就位，`target_url` 写入完整
- 后端部署：Worker 在线更新

### 修改文件
- 🆕 无（纯增强）
- `worker-api.ts` ✏️ 5 类入口加 `addNotice` 触发 + `target_url` 参数（模块 A 已存在，本轮仅核对确认）
- `server/index.ts` ✏️ 同步 5 类入口通知 + `parent_id` 子评论支持
- `server/helpers.ts` ✏️ `addNotice` 加 `targetUrl` 可选参数
- `schema.sql` ✏️ `notices` 表加 `target_url TEXT`
- `src/components/CommentTree.vue` ✏️ 列表容器 `id="comment-area"` + 每条评论 `:id="'comment-'+c.id"`
- `src/components/NavBar.vue` ✏️ 通知点击后 `router.push` + 滚动锚点 + `.n-type.comment/like` 颜色

---

## [v4.2.0] - 2026-08-28

> 评论二级回复（朋友圈折叠树）+ 抽公共 CommentTree 组件

### 新增
- **朋友圈式折叠树子评论**：主评论平铺、点"展开 N 条回复"显示子评论、点"回复"就地弹出输入框（@用户名 + 取消 + Ctrl+Enter 发送）
- **公共组件 `src/components/CommentTree.vue`**：通用 props（comments / current-user / can-delete / on-submit / on-delete / empty-text），一次实现全站生效
- **3 个评论界面接入**：
  - 美文 `ArticleView.vue`
  - 博客 `BlogDetailView.vue`
  - 论坛帖子 `SubjectForumPostView.vue`
- **数据库**：`article_comments` / `page_comments` 各加 `parent_id INTEGER` 字段 + 索引（在线 ALTER 不影响历史数据）
- **删除策略**：删主评论连同所有子评论一起删（朋友圈同款）；删子评论只删自己

### 后端变更
- `POST /api/articles/:id/comments`：接受 `parent_id` 可选；`null` = 主评论，否则为该评论的回复
- `POST /api/pages/:id/comments`：同上（论坛/博客/公告共享）
- `DELETE /api/articles/:id/comments/:commentId`：
  - 主评论（`parent_id IS NULL`）→ `DELETE WHERE id=? OR parent_id=?`（级联删所有回复）
  - 子评论 → `DELETE WHERE id=?`（只删自己）
  - 经验值回收：仅主评论扣回 `comment` 经验（-1），子评论无独立经验
- `DELETE /api/pages/:id/comments/:commentId`：同上
- 经验值：仅主评论给文章作者 +1（避免回复刷经验）

### 数据库变更
```sql
ALTER TABLE article_comments ADD COLUMN parent_id INTEGER;
ALTER TABLE page_comments ADD COLUMN parent_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_art_c_p ON article_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_page_c_p ON page_comments(parent_id);
```

### 前端变更
- `src/components/CommentTree.vue` 🆕 公共组件（~450 行，含 .vue + .css）
- `src/api/index.ts` ✏️ `addArticleComment` / `addPageComment` 加可选 `parentId` 参数
- `src/views/ArticleView.vue` ✏️ 替换 17 行内联评论 → 11 行 `<CommentTree ...>`
- `src/views/BlogDetailView.vue` ✏️ 同上
- `src/views/SubjectForumPostView.vue` ✏️ 同上

### 验证
- `npm run build` 通过（exit 0，13.60s）
- 沙箱产物验证：`CommentTree-BHxiGr7N.js` 独立 chunk，3 个评论界面（ArticleView / BlogDetailView / SubjectForumPostView）都正确引用
- 线上：`CommentTree-CuCsvXVW.js` 已部署，命中 `parent_id` / `回复` / `展开` 关键文案
- Worker：部署到 Cloudflare（Version 84dc0805-8bce-468f-b1a7-8d8fdd607361），3 个评论接口升级生效
- 后端 schema 升级：在线 ALTER TABLE，D1 数据库历史数据零丢失
- 沙箱出网受限（HTTP 000 已知问题）→ 实际效果由用户在生产环境验证

### 修改文件（6 个，+455/-136）
- 🆕 `src/components/CommentTree.vue`（公共组件）
- `src/api/index.ts` ✏️ addArticleComment / addPageComment 加 parentId
- `src/views/ArticleView.vue` ✏️ 接入 CommentTree
- `src/views/BlogDetailView.vue` ✏️ 接入 CommentTree
- `src/views/SubjectForumPostView.vue` ✏️ 接入 CommentTree
- `worker-api.ts` ✏️ schema 升级 + 2 个 POST 接受 parent_id + 2 个 DELETE 级联

---

## [v4.1.6] - 2026-08-28

> 个人主页经验值进度条 bug：除 Lv.1 外均显示满条

### 修复
- **根因**：`ProfileView.vue` 手写 `calcProgress()` 算法错误（行 74-80）
  ```ts
  // 旧代码（错）
  const need = expToNextLevel(cur)             // 返回"下一级起点累计经验"（不是差值）
  const levelBase = (levelFromExp(cur) - 1) * 100  // 硬编码 100 经验/级，实际 60
  return Math.min(100, ((cur - levelBase) / (need - levelBase)) * 100)
  ```
  - 每级档位 60（`utils/helpers.ts` 的 `levelExp(level) = (level-1) * 60` + `levelFromExp = floor(exp/60)+1`）
  - 旧代码把档位当成 100 → `levelBase` 算小（用户 180 EXP：旧算出 300，正确是 180）→ 分子过大 → 经常超 100% → `Math.min(100, …)` 截到 100 → **满条**
  - Lv.1 看似"正常"纯属巧合：用户 Lv.1 经验值小到刚好 ≤100%
- **修复**：直接用 `helpers.expProgress(exp)`（行 18-20）现成函数
  ```ts
  // utils/helpers.ts
  export function expProgress(exp: number): number {
    return Math.round(((exp % 60) / 60) * 100)
  }
  ```
  - 模板 `:style="{ width: expProgress(user.current.exp) + '%' }"`
  - "距下一级 N EXP" 改为 `computed(() => 60 - (cur % 60))`，整除时为 60
- **删除**：`calcProgress()` 函数 + `expToNextLevel` / `levelFromExp` 旧 import（改用 `expProgress` + computed）

### 验证
- `npm run build` 通过（exit 0，14.47s）
- 沙箱 Node 跑 13 个测试点（0/10/30/59/60/80/120/180/200/240/300/599/600 EXP），所有档位进度 + 距离下一级都正确
- 关键用例：200 EXP（旧算法满条）→ 新算法 33%；120 EXP → 0%（刚到 Lv.3）；599 EXP → 98%
- 本轮按规则"先奏后斩"——前端 build 通过 + 沙箱验证完成 + git push → Cloudflare Pages 自动构建
- 后端 `worker-api.ts` / `server/index.ts` 本轮零改动（铁律：bug 全在前端可解就不动后端）

### 修改文件
- `src/views/ProfileView.vue` ✏️ import 改 expProgress + 删 calcProgress + 加 expLeftToNext computed + 模板用新函数

---

## [v4.1.5] - 2026-08-28

> 经验值说明页「发布论坛帖」规则在用户面显示为英文 key（forum_post）bug 修复

### 修复
- **根因**：v4.1.0 学科论坛上线时，worker-api 在论坛帖自动通过 / 审核通过时调用 `addExp(uid, undefined, 'forum_post', ...)` 写经验值（worker-api.ts 行 2900 / 2964）。
  - **管理员后台** `ExpRulesView.vue` 的 `RULE_META` 同步加了 `forum_post` 的中文 label
  - 但**用户面** `ExpDocView.vue`（经验值说明）和 `GuideView.vue`（网站说明 → 经验值获取规则）的 `RULE_DESC` 字典**漏加**这条 → 命中 fall-through `{ label: k, icon: '⭐', desc: '' }` → 用户看到英文 key `forum_post` + 空描述
- **修复**：两个用户面页面的 `RULE_DESC` 都加上 `forum_post` 条目
  - label：「发布论坛帖」
  - icon：「💬」（与论坛语义一致）
  - desc：「论坛帖子审核通过/自动通过」

### 验证
- `npm run build` 通过（exit 0，14.19s）
- 沙箱：`grep -lE "发布论坛帖|论坛帖子审核通过"` 在产物中命中 ExpRulesView + GuideView 两个 chunk（ExpDocView 被合并到 index 主 chunk），新文案已就位
- 本轮按规则"先奏后斩"——前端 build 通过 + 沙箱验证完成 + git push → Cloudflare Pages 自动构建
- 后端 `worker-api.ts` / `server/index.ts` 本轮零改动（铁律：bug 全在前端可解就不动后端）

### 修改文件
- `src/views/ExpDocView.vue` ✏️ RULE_DESC 加 forum_post
- `src/views/GuideView.vue` ✏️ RULE_DESC 加 forum_post

---

## [v4.1.4] - 2026-08-28

> 学科论坛侧栏：最新帖子 → 最热帖子（与主列表时间排序去重）

### 修复
- **侧栏"最新帖子"与主列表重复**：主列表本就按 `created_at` 倒序，侧栏再放一份"最新"完全冗余 → 改为"🔥 最热帖子"
- **热度算法**：每条帖子计算 `_heat = views * 0.4 + comment_count * 0.6`，按 `_heat` 倒序；同分按 `created_at` 倒序（新帖优先）。取前 5 条
- **UI 增强**：前 3 名加奖牌色编号（🥇 金 / 🥈 银 / 🥉 铜），副标题同时显示作者 / 浏览数 / 评论数，让"热"有依据

### 验证
- `npm run build` 通过（exit 0，14.54s）
- 沙箱：相同数据下，原"最新"→ 新"最热"会按加权分重排，主列表的顺序不受影响（仍按时间排）
- 本轮按规则"先奏后斩"——前端 build 通过 + 沙箱验证完成 + git push → Cloudflare Pages 自动构建
- 后端 `worker-api.ts` / `server/index.ts` 本轮零改动（铁律：bug 全在前端可解就不动后端）

### 修改文件
- `src/views/SubjectForumView.vue` ✏️ 模板：最新 → 最热（加 rk1/2/3 奖牌 + 浏览/评论数显示） + JS：latestPosts → hotPosts（加权热度算法） + CSS：.hot-rank 三色

---

## [v4.1.3] - 2026-08-28

> 论坛 bug 二次修复：预览后空白彻底根治 + 免审阈值 UI 内嵌到论坛模块卡

### 修复
- **预览后编辑器空白（v4.1.2 未根治，二次修复）**：
  - 根因复盘：v4.1.2 用 `v-if` 切换 editor/preview，切换时 editor div 重建 + `innerHTML` 回填存在 Vue 两次 nextTick 竞态；`watch(editorContent)` 兜底又**仅在失焦时回填**，焦点仍在编辑器时永远不触发。
  - 改为 **`v-show` 替代 `v-if`**：editor 和 preview 两个 div 永远在 DOM 里，切换只是 `display:none/block`，`editorRef` 永不重建，`innerHTML` 永不丢。
  - 同步删除已无用的 `togglePreview` 切回分支的 `nextTick` 回填代码与 `watch(editorContent)` 兜底逻辑（v-show 模式下不再需要）
- **论坛免审阈值 UI 不直观**：
  - 之前"论坛免审阈值" el-input-number 散落在 mod-grid 下方，论坛模块开启才显示——不直观。
  - 改为**直接内嵌到论坛模块卡片内**（`.mc-sub`）：论坛开关下面紧跟一个分割线 + el-input-number + 提示文字。
  - 论坛模块**关闭时** el-input-number 处于 disabled 状态（视觉上一眼能看出"开关 + 阈值"是绑定的）。
  - 删掉已无用的 `.forum-thresh` / `.ft-hint` 样式。

### 验证
- `npm run build` 通过（exit 0，14.43s，4 条论坛路由全在，SubjectForumEditView 懒加载 chunk 11.4KB）
- 沙箱：v-show 切换不重建 DOM，光标/选区/contenteditable 状态全程保留 → 预览后编辑必不空白
- 本轮按规则"先奏后斩"——前端 build 通过 + 沙箱验证完成 + git push → Cloudflare Pages 自动构建
- 后端 `worker-api.ts` / `server/index.ts` 本轮零改动（铁律：bug 全在前端可解就不动后端）

### 修改文件
- `src/views/SubjectForumEditView.vue` ✏️ v-if → v-show + 简化 togglePreview + 删 watch 兜底
- `src/views/admin/SubjectsAdminView.vue` ✏️ 论坛模块卡内嵌阈值输入框 + .mc-sub CSS

---

## [v4.1.2] - 2026-08-28

> 论坛体验补完：发帖改为独立页（含草稿自动保存）+ 桌面两栏中央阅读 + 修复预览后编辑器空白

### 新增
- **论坛发帖独立页 `SubjectForumEditView.vue`**（参考 `BlogEditView`）：
  - 路由 `/subject/:slug/forum/new`（新帖）、`/subject/:slug/forum/post/:id/edit`（编辑）
  - 桌面两栏：左侧主编辑区（标题 / 话题 / 推荐语 / 富文本 / 预览 / 草稿状态 / 操作），右侧写作助手（话题快捷打标 / 发帖规则 / 学科教师提示）
  - **草稿自动保存** 接入 `useAutoSave` composable（`localStorage` 兜底，1.5s 防抖）：
    - 离开页面进入新页面会自动恢复
    - 编辑模式有草稿时弹窗询问"恢复 / 放弃"
    - 标题栏右上角显示"草稿已自动保存 · N 秒前"
    - 底部"保存草稿 / 清除草稿"显式按钮
  - 完整富文本工具栏：B / I / U / H2 / H3 / 段落 / 引用 / 有序+无序列表 / 图片 / 表情 / 预览
  - 免审/审核提示保留并改用 `isStaff` 判定（学科教师 + 超管都直接发布）
  - 提交成功后 `clear()` 草稿 + 跳详情页
- **`router/index.ts`**：新增 2 条论坛路由
- **`SubjectForumView.vue` 重写**：
  - 桌面两栏布局（`max-width: 1280px`）：左侧主列表，右侧 300px 侧栏（热门话题 Top-N + 最新帖子 Top-5 + 学科信息）
  - 删除原 el-dialog 发帖/编辑入口；"我要发帖" / "编辑" 跳新独立页
  - 列表网格在 ≥1100px 时改双列
- **`SubjectForumPostView.vue` 重写**：
  - 桌面两栏布局：中央帖子正文 + 评论，右侧 300px 侧栏（作者头像 / 相关帖子 / 学科信息）
  - 删除原 el-dialog 编辑入口；"编辑" 跳新独立页
  - 评论/审核 UI 完全保留

### 修复
- **论坛预览后编辑器空白**：`togglePreview()` 切回编辑态时**把 `editorContent` 重新写回 `editorRef.innerHTML`**（`nextTick` 内），解决 `v-if` 切换 contenteditable div 重建后内容丢失的 bug；并加 `watch(editorContent, …)` 兜底运行期内容回填

### 数据库变更
- 无（仅前端）

---

## [v4.1.1] - 2026-08-28

> 论坛 v4.1.0 上线后的体验补完：模块开关/桌面适配/审核复用/免审阈值/富文本发帖
> 提交：`ea832d6` v4.1.1 学科论坛：模块开关/桌面适配/审核复用美文流/<1000字免审/富文本发帖
> 提交：`0eeb595` feat(论坛审核): AuditView 加论坛 tab 模板块（与美文/资料完全同 UI 流程）；帖子列表移除快捷审核按钮统一走审核中心

### 新增
- **超管可控制论坛模块显隐**：`SubjectsAdminView` 把 `forum` 列入模块开关列表，关闭后 `SubjectView` 的「学科论坛」tab 自动隐藏
- **论坛免审阈值配置（按学科）**：`subjects.forum_auto_approve_threshold` 字段（0=关闭，>0 时纯文本字数 ≤ 阈值自动 `published`），`SubjectsAdminView` 在论坛模块开启时显示「论坛免审阈值」设置项（步进 100，0~10000）
- **`POST /api/subjects/:id/forum/posts` 自动免审逻辑**：超管/本学科教师直接 `published`；其他角色若 `threshold > 0` 且 纯文本字数 ≤ 阈值则自动 `published`（返回 `autoApproved: true`），否则 `pending`
- **`PATCH /api/subjects/:id/forum-config`**：更新论坛免审阈值（仅超管/本学科教师可写）
- **超管/本学科教师可审核论坛帖子**（**完全复用美文/资料的审核 UI 流程**）：
  - `PATCH /api/subjects/:id/forum/posts/:pid/status` 接收 `{status, reviewNote}`，支持 `pending/published/rejected` 流转
  - 通过 → `addExp(author, 'forum_post', +N)`（按经验规则）+ `addNotice` 通知；驳回 → 通知带驳回原因
  - **`AuditView` 新增「论坛」tab 模板块**，结构/按钮/状态显示与「美文 / 资料」100% 一致；列表来自新增的 `GET /api/admin/audit/forum-posts`（按权限过滤学科）
  - 帖子列表的"通过/驳回"快捷按钮**已删除**——所有审核走审核中心，避免入口不一致
- **富文本发帖（与博客 BlogEditView 一致的工具栏）**：`SubjectForumView` 发帖 dialog 工具栏支持 B / I / U / H2 / 段落 / 引用 / 列表 / 图片插入 / 表情 / 预览切换；`execCommand` 富文本 + 字数统计 + 免审阈值提示
- **`api/index.ts` 新增 3 个 API 方法**：`updateSubjectForumConfig` / `adminAuditForumPosts` / `auditForumPost`

### 修复
- **论坛 canManageSubject 调用缺少 subject_id 入参的最后一处**：`forum-config` PATCH 已补传 `subject_id` 兜底字段
- **`SubjectForumPostView` 桌面端宽度限制**：详情页加入 `max-width` + 居中布局，避免大屏拉满

### 数据库变更
- D1 `subjects` 表新增 `forum_auto_approve_threshold`（INTEGER，default 0）

---

## [v4.1.0] - 2026-08-27

### 新增
- **学科论坛（每个学科一个）** — 复用 `pages` 表 + 新表 `forum_topics`：
  - 帖子（ptype='forum'）走 `subject_id` 区分学科
  - 话题标签独立维护，可选 1-3 个贴在帖子上，话题带颜色
  - 评论复用 `page_comments`（既有的页面评论）
  - 权限：跨学科教师/学生 = 学生权限（只读 approved + 自己的 pending）；本学科教师/超管 = 全部
  - 帖子状态：超管/本学科教师 = 直接 `published`；学生/跨学科教师 = `pending`（待审核）
- **11 个新 API**（worker-api.ts + server/index.ts 同步）：
  - `GET/POST /api/subjects/:id/forum/topics` — 列出/创建话题标签
  - `PATCH/DELETE /api/subjects/:id/forum/topics/:tid` — 编辑/删除话题（限超管+本学科教师）
  - `GET /api/subjects/:id/forum/posts` — 列出帖子（按权限过滤）
  - `GET /api/subjects/:id/forum/posts/:pid` — 帖子详情（views +1）
  - `POST /api/subjects/:id/forum/posts` — 发帖（带 topicIds 数组）
  - `PATCH/DELETE /api/subjects/:id/forum/posts/:pid` — 编辑/删除帖子（作者/超管/本学科教师）
- **2 个新前端页面**：
  - `SubjectForumView.vue` — 话题 chip + 帖子卡片列表 + 新建/编辑 dialog
  - `SubjectForumPostView.vue` — 帖子详情 + 评论列表 + 编辑/删除
- **3 个新路由**：
  - `/subject/:slug/forum` — 学科论坛首页
  - `/subject/:slug/forum/post/:id` — 帖子详情
- **`SubjectView.vue` 新增「学科论坛」tab**，点 tab 跳到独立路由（便于深链接）
- **`api/index.ts` 新增 9 个 API 方法**：`forumTopics/createForumTopic/updateForumTopic/deleteForumTopic/forumPosts/forumPost/createForumPost/updateForumPost/deleteForumPost`

### 修复
- **论坛 canManageSubject 漏传 subject_id**：7 处论坛路由原本只传 `{id, role}`，导致只填了 `users.subject_id` 而没进 `class_members` 的教师被错判 403。已补传 `subject_id` 字段，兜底逻辑生效
- **教师编辑话题 PATCH 同上 bug**：单独修一处

### 数据库变更
- D1 `pages` 表新增 `subject_id`（INTEGER，nullable）、`topic_ids`（TEXT，default `'[]'`）
- D1 新表 `forum_topics`（id, subject_id, name, color, created_by, created_at）+ 索引 `(subject_id)`

### 修改文件
- `worker-api.ts`（+11 个路由 + canManageSubject 7 处补传 subject_id）
- `server/index.ts`（同步）
- `src/api/index.ts`（+9 个 API 方法）
- `src/router/index.ts`（+2 路由）
- `src/views/SubjectView.vue`（+tab +onTabClick 跳转）
- `src/views/SubjectForumView.vue`（新建）
- `src/views/SubjectForumPostView.vue`（新建）

### 部署
- Worker 版本：`65d5ef7a-d45d-45b2-adc4-5909f9793446`
- 前端：通过 GitHub push → Cloudflare Pages 自动构建
- 沙箱 E2E：19/19 全部通过（教师/学生/超管；CRUD 全部 + 跨权限拒绝）

---

## [v4.0.2] - 2026-08-27

### 修复
- **Bug-教师跨学科读列表 403 反弹**（按用户最新意图反 v4.0.1 的收紧）：
  - `GET /api/resources`：删除"教师传 subjectId 时必须在本任教学科内"的 403，改为"跨学科同学生只看 approved；本学科额外看自己上传的全部状态"
  - `GET /api/articles`：同上（删 403）
  - `GET /api/quizzes`：同上（删 403，按"任教学科 + 自己创建"过滤）
  - `GET /api/subjects/:id/questions`：去掉 `requireSubjectStaff` 中间件。跨学科教师/学生只看 `status='active'`，本学科教师/超管看全部
- **Bug-/api/stats 教师只看到本学科数量**：
  - 删除 `teacherSid` 过滤分支，改为全站统计口径
  - 教师/学生/超管在首页 hero-stats 看到的 `资料/美文/查询任务/题库` 数字一致
- **Bug-学生单题自测弹窗 ElementPlusError**：
  - `QuizListView.vue:158` `el-dialog title=...` → `<template #header>`
  - `QuizEditView.vue:259` `el-dialog title=...` → `<template #header>`

### 修改文件
- `worker-api.ts`（resources/articles/quizzes/questions/stats 共 5 处）
- `server/index.ts`（同步本地后端 5 处）
- `src/views/quiz/QuizListView.vue`（el-dialog 兼容性）
- `src/views/quiz/QuizEditView.vue`（el-dialog 兼容性）

### 部署
- Worker 版本：`523d6d03-265f-4388-b880-f139e5291c17`
- 验收账号：teacher1 / 123456（已重置），主学科=1（语文）

---

## [v4.0.0] - 2026-08-25

### 修复
- **Bug1 经验值缺失（超管/教师直接 approved 不加经验）**：`POST /api/resources` 在 status='approved' 时立即 `addExp(id, undefined, 'resource', ...)`，不再依赖审核流。
- **Bug3 学科教师权限（支持多学科任教）**：`canManageSubject` 改为 async + 复用 `teachingSubjects`（从 class_members.role_in_class='TEACHER' 聚合），不再只看 `user.subject_id` 单字段。
- **Bug4-9 教师跨学科越权**：
  - 新增 `requireSubjectStaff(source, key)` 中间件：params/query 来源校验任教学科，仅放行 SUPER_ADMIN / 本学科 TEACHER
  - 覆盖：美文/资料/题库/单题训练/公告/学科题目/题库选题等所有相关端点
  - 端到端教师账号现在无法跨学科发布、无法访问他学科的题目/数据
- **Bug10 考试题源兼容模式**：`POST /api/quizzes` 同时支持两种题源
  - `questions` 数组（内联，教师自编）
  - `questionIds` 数组（从 subject_questions 选题，按原顺序插入）
  - 两者都给时先内联再题库；跨学科题会被 400 拒绝
- **Bug11 学科榜数据一致性**：`/api/leaderboard` 总榜从 `exp_logs` 聚合（COALESCE(SUM(exp_change),0)）覆盖 `users.exp`，确保月榜 ≤ 总榜成立。
- **Bug12 博客 PATCH + 编辑入口**：
  - 后端：`PATCH /api/pages/:id`（作者本人或超管）允许编辑标题/内容/封面/标签
  - 前端：`BlogEditView.vue` 增加编辑模式（从 `/blog/:id/edit` 进入），`BlogListView.vue` 我的博客卡片加 ✏️ 按钮
  - 后端 `api/index.ts` 加 `updatePage(id, payload)`
- **Bug15 通知全部已读**：`PUT /api/notices/read-all` 校验 SQL 关键字 `UPDATE notices SET read=1 WHERE user_id=? AND read=0`，read=0 过滤确保不重置已读。

### 修改文件
- `worker-api.ts`（+200/-54，权限/兼容/聚合/博客/通知 多处）
- `server/index.ts`（+46/-15，与 Worker 同步）
- `server/auth.ts`（+31，权限工具函数）
- `src/api/index.ts`（+2，`updatePage`）
- `src/views/BlogEditView.vue`（+103，编辑模式）

### 部署
- 前端：`git push origin main`（Pages 自动构建）
- 后端：`wrangler deploy` → version `5c07bc6d-8adf-4cfb-9f63-4fd12050b4e9`
- 沙箱验证：前端/后端 health/guide 全部 HTTP 200，超管登录后 users/resources/quizzes/notices/exp/logs 全部 200

### 待办（积分恢复后继续）
- Phase A10 前端：字体弹窗修复 / 编辑器空格保留 / 博客编辑入口在更多页面
- Phase D 轻量编辑器：学科公告用 纯 Markdown 文本 + 预览（你已选）
- 完整三角色端到端浏览器测试（学生/教师/超管各操作一遍）

---

## [v3.0.10] - 2026-08-25

### 修复
- **通知中心跑到左上方（真正根因找到）**：
  - 真正根因：NavBar.vue里`<el-drawer direction="right">`用了Element Plus**无效的方向值**。Element Plus 2.x drawer的direction prop是枚举类型 `ltr | rtl | ttb | btt`，传`"right"`或`"left"`会触发Vue prop validation警告，但fallback到原始值作为class名渲染出`<div class="el-drawer right">`（**没有`rtl`/`ltr` class**），导致`el-drawer.rtl { right: 0 }`等所有方向相关CSS选择器**全部失效**，drawer用默认position:absolute但没有right/left值，于是出现在包含块（el-overlay）的左上角
  - 修复：
    1. NavBar.vue：通知中心drawer的`direction="right"`改为`direction="rtl"`（Element Plus正确枚举值）
    2. NavBar.vue：菜单drawer的`direction="left"`改为`direction="ltr"`
    3. main.css：全局`.el-drawer`显式设置`position: absolute !important; top: 0; bottom: 0`；`.el-drawer.rtl { right: 0 !important; left: auto !important }`；`.el-drawer.ltr { left: 0 !important; right: auto !important }`——三层防御确保方向永远正确

### 修改文件
- `src/components/NavBar.vue`（direction枚举值修正）
- `src/styles/main.css`（el-drawer全局position/方向强制定位）

---

## [v3.0.9] - 2026-08-25

### 修复
- **导航栏不固定（根本原因已找到并修复）**：
  - 真正根因：main.css中`html, body { overflow-x: hidden; }`（第2318行）和`.zg-root { overflow-x: hidden; }`（第2319行）会创建新的BFC/隐式滚动容器，破坏sticky定位的containing block，导致sticky元素跟随容器一起滚动
  - 修复：
    1. `.zg-root`移除`overflow-x: hidden`（改用body的`overflow-x: clip`防止水平溢出）
    2. `html, body`全局的`overflow-x: hidden`改为`overflow-x: clip`，`clip`不会创建新的滚动容器
- **通知中心跑到左上角/不可关闭（回滚v3.0.8的错误is-drawer修改）**：
  - 根因：v3.0.8错误地给`.el-overlay.is-drawer`设置了`display:block; overflow:hidden`，导致drawer被强制block布局脱离了正常流程
  - 修复：完全回滚`.el-overlay.is-drawer`相关CSS和`:not(.is-drawer)`选择器
  - Element Plus 2.x drawer实际DOM结构是`.el-overlay > .el-drawer`，**不经过`.el-overlay-dialog`**，所以弹窗居中样式天然不影响drawer
  - `.el-overlay`移除之前v3.0.8的`position:fixed !important; inset:0`（Element Plus内部已经设了fixed，重复设置反而可能干扰drawer）

### 修改文件
- `src/styles/main.css`（彻底修复overflow-x:hidden→clip、移除zg-root overflow、移除错误的is-drawer和el-overlay强制fixed）

---

## [v3.0.8] - 2026-08-25

### 修复
- **导航栏不固定（跟着页面乱跑）根因修复**：
  - 根源1：`html, body, #app { height: 100%; }`配合body的`overflow-x: hidden`，导致浏览器隐式创建滚动容器，破坏sticky定位
  - 根源2：`.zg-inkgold .nav`和`.zg-inkgold-dark .nav`之前设了`position: relative !important`覆盖了sticky（上一版已修复），但经典模式的nav依赖组件scoped样式的`position:sticky; top:0`
  - 修复：移除`html, body, #app { height:100% }`，改为`#app { min-height: 100dvh }`；body只保留`overflow-x:hidden`，不设置height/overflow-y，让页面滚动在viewport级别，sticky正常工作
- **电脑端通知中心跑到左上角根因修复**：
  - 根源：`.el-overlay`没有明确设置`position:fixed`，被Element Plus默认样式或其他样式干扰；`.el-overlay-dialog`全局设置了`display:flex; justify-content:center; align-items:center`，这个居中样式影响了drawer所在的overlay，导致drawer被flex居中到左上角
  - 修复：
    1. `.el-overlay`显式设置`position:fixed !important; top:0; right:0; bottom:0; left:0; overflow:auto`，确保遮罩层始终覆盖全屏
    2. 利用Element Plus的`is-drawer`类区分：`.el-overlay.is-drawer`设为`display:block; overflow:hidden`，不使用flex居中
    3. `.el-overlay.is-drawer .el-overlay-dialog`设为`display:block; padding:0`，不干扰drawer定位
    4. 移动端两处media query中的el-overlay flex居中改为`:not(.is-drawer)`，只对dialog/message-box居中，不影响drawer
    5. 经典模式（全局.el-drawer）和墨金模式的抽屉定位都得到修复

### 修改文件
- `src/styles/main.css`（修复html/body/#app高度和overflow、el-overlay fixed定位、is-drawer类排除flex居中）

---

## [v3.0.7] - 2026-08-25

### 修复
- **导航栏不固定（跟着页面乱跑）根因修复**：
  - 根源：main.css中`.zg-inkgold .nav`（第1127行）和`.zg-inkgold-dark .nav`（第1668行）设置了`position: relative !important`，用!important覆盖了组件scoped样式中的`position: sticky`，导致sticky定位完全失效
  - 修复：改为`position: sticky !important; top: 14px`（桌面端配合margin:14px形成悬浮胶囊效果），移动端top:8px配合margin:8px；所有5处移动端media query中的导航栏样式统一修复
- **美文封面四周白色边距（不是填充模式）根因修复**：
  - 根源1：最后一个移动端media query给`.art-card`设置了`padding: 16px !important`，导致封面图片四周有白色内边距
  - 根源2：`.ac-cover`没有强制`background-size: cover !important`，可能被其他样式覆盖为contain
  - 修复：art-card padding改为0，ac-body单独设padding；ac-cover强制`width:100%; background-size:cover !important; margin:0; border-radius:0; height:180px`，封面完全填满卡片顶部

### 修改文件
- `src/styles/main.css`（修复导航栏position:sticky、top值、圆角统一；修复art-card padding）
- `src/views/HomeView.vue`（ac-cover强制cover填充模式、art-card padding:0）

---

## [v3.0.6] - 2026-08-25

### 修复
- **移动端抽屉/弹窗直角问题彻底修复（根源）**：
  - 根源：main.css中有**8个**`@media (max-width: 768px)`媒体查询块，其中B8块（第2032行）和"全面适配"块（第2474行）在最后面设置了`border-radius: 20px 0 0 20px`单侧圆角，覆盖了前面所有四个圆角设置
  - 深色档全局样式（第1465行、第1792行）也设置了单侧圆角，不在media query里，覆盖了移动端
  - 修复：统一CSS结构——基础样式只设全边框+overflow:hidden；单侧圆角/边框/阴影只在桌面端media query(min-width:769px)中设置；移动端media query(max-width:768px)统一四个圆角18px+四周12px边距悬浮卡片式
- **电脑端通知中心定位问题修复**：
  - 根源：深色档抽屉样式设置了全局单侧border-left，且el-drawer被错误设置样式干扰
  - 修复：确保桌面端抽屉不设置任何position/top/left/right/bottom/width/height/transform，只修改border/border-radius/box-shadow/background，保留Element Plus原生fixed定位和transform滑入动画
- **移动端底栏胶囊修复**：
  - 根源：最后一个移动端media query（第2588行）设置了`border-radius: 18px 18px 0 0 !important`（只有顶部圆角，底部直角），覆盖了组件内的29px完美胶囊圆角
  - 修复：删除该错误覆盖，底栏保持组件内border-radius:29px胶囊形状
- **导航栏胶囊圆角增大**：桌面端border-radius从20px改为28px，移动端从16px改为22px
- **Hero区更透**：L1层玻璃填充从rgba(255,255,255,0.70/0.65)降至0.55/0.50
- **深色档抽屉圆角修复**：深色档单侧圆角移入桌面端media query，移动端四个圆角

### 修改文件
- `src/styles/main.css`（彻底重构抽屉CSS三层结构、删除所有重复冲突的单侧圆角、修复底栏错误覆盖、导航栏圆角增大、Hero更透）
- `src/components/NavBar.vue`（导航栏圆角28px胶囊）

---

## [v3.0.5] - 2026-08-23

### 修复
- **移动端抽屉/弹窗直角问题彻底修复**：
  - 根源1：`.zg-inkgold .el-drawer.ltr`/`.rtl`全局单侧圆角样式（不在media query里），用!important覆盖了移动端的四个圆角
  - 根源2：基础样式预设了`border-left`和单侧圆角，移动端清除不彻底
  - 修复：重构CSS结构——基础样式只设全边框玻璃效果，桌面端media query(min-width:769px)才应用单侧边框/圆角/阴影，移动端media query(max-width:768px)用left/right/top/bottom精确定位悬浮卡片（上下左右各留边距），确保四个18px圆角完整显示
- **桌面端通知中心定位修复**：彻底确保el-drawer不被设置position:relative，保持Element Plus默认position:fixed；桌面端单侧样式移入min-width:769px媒体查询，避免干扰
- **移动端抽屉悬浮卡片效果**：左侧抽屉left:12px/right:48px/top:12px/bottom:12px，右侧抽屉right:12px/left:48px/top:12px/bottom:12px，形成四周留白的悬浮玻璃卡片

### 修改文件
- `src/styles/main.css`（重构抽屉CSS：基础样式+桌面端媒体查询+移动端媒体查询三层结构，删除全局ltr/rtl单侧圆角）

---

## [v3.0.4] - 2026-08-23

### 修复
- **严重BUG：通知中心出现在页面上方而非右侧**：main.css错误地给`.zg-inkgold .el-drawer`加了`position: relative`，覆盖了Element Plus默认的`position: fixed`，导致抽屉无法固定在视口右侧，而是在页面流中显示在顶部。已移除el-drawer/el-dialog的position:relative。
- **移动端弹窗/抽屉直角问题**：
  - 原因1：之前用`[direction="left"]`属性选择器，但Element Plus实际用`.ltr`/`.rtl`类名，导致左侧抽屉用了右侧抽屉的圆角样式（左上左下圆角、右上右下直角）
  - 原因2：移动端抽屉/弹窗只给了单侧圆角，现在改为**四个圆角**，并添加适当margin不贴死屏幕边缘
- **移动端底栏胶囊形状修复**：dock的border-radius从22px改为29px（高度58px，半径29px是完美胶囊），tab和透镜也同步改为25px圆角；修复经典暖橘模式下`border-radius:0 !important`的问题
- **移动端底栏新增通知中心按钮**：底栏tabs加入「通知」按钮（铃铛图标+未读数红点），点击通过`zg-open-notice`事件打开右侧通知抽屉；学生角色底栏变为：首页/科目/通知/我的 四个按钮，教师/管理员额外加「管理」共五个
- **底栏未读数同步**：MobileTabBar直接调用api获取通知未读数，并监听`messages-read`事件即时刷新

### 修改文件
- `src/styles/main.css`（移除el-drawer/el-dialog的position:relative、移动端弹窗/抽屉四个圆角、修复类名选择器）
- `src/components/MobileTabBar.vue`（完美胶囊形状、新增通知按钮+未读红点、修复圆角一致性、修复TS类型错误）

---

## [v3.0.3] - 2026-08-23

### 核心修复
- **浅色背景玻璃参数重大修正**：深色背景和浅色背景玻璃参数完全不同！之前错误地把深色参数(大blur/内底暗边)用到浅色暖白背景上，导致玻璃发灰、发脏、像廉价塑料
- **blur值下调**：浅色背景用中blur(12-16px)而非大blur(24-28px)，大blur在浅色上会过度模糊导致糊成一片
- **移除内底暗边**：浅色背景上inset 0 -1px 0 rgba(120,90,30,0.04-0.06)看起来是脏线！不是厚度！只在深色档保留内底暗边
- **saturate从180%降至140%**：过高饱和度在浅色背景上让颜色发飘、不真实
- **边框改为暖金色**：从白色边框(rgba(255,255,255,0.35))改为暖金边框(rgba(184,148,63,0.12-0.15))，融入暖白背景
- **背景填充更实**：从0.45-0.60提高到0.65-0.80，浅色上需要更实的填充才有质感，不是越透明越好

### 问题修复清单
- **NavBar双position冲突**：修复了同时存在`position: sticky`和`position: relative`的矛盾，统一用sticky
- **Hero金色发光品牌条被覆盖**：之前错误地用.hero::before做顶部高光，覆盖了原本的金色发光品牌标识，已恢复品牌金色光线
- **stats统计区散乱小玻璃块**：hero-stats改为整体一块玻璃容器，内部数据项不再各自为战做独立玻璃，视觉更整体
- **用户头像按钮blur值过大**：从20px改为12px，小元素用小blur
- **tab-lens透镜内底暗边**：移除浅色档透镜的inset底部暗边
- **所有组件统一使用CSS变量**：不再硬编码blur(24px) saturate(180%)，统一引用--zg-glass-blur/--zg-glass-sat

### 移动端补充适配
- **导航栏移动端圆角**：border-radius:16px，max-width:calc(100% - 16px)，margin:8px auto
- **弹窗移动端适配**：宽度calc(100% - 24px)，margin:12px auto，圆角18px，内边距适配
- **抽屉移动端圆角**：右侧抽屉border-radius:18px 0 0 18px，左侧抽屉0 18px 18px 0
- **移动端内容边距统一**：内边距从12px/18px统一规范

### 深色档独立参数
- 深色档保留：大blur(20-24px)+暖白边框+内顶高光+内底暗边的正确参数组合
- 深色档独立设置所有CSS变量，不与浅色档混用

### 修改文件
- `src/styles/main.css`（v17.1浅色玻璃参数修正、深色档独立变量、移动端弹窗/抽屉适配）
- `src/components/NavBar.vue`（移除双position、用户按钮blur修正、高光透明度降低）
- `src/components/MobileTabBar.vue`（dock blur统一用变量、移除透镜内底暗边、高光透明度降低）
- `src/views/HomeView.vue`（恢复Hero金色品牌条、stats整体玻璃化、所有组件blur统一、移除散乱小高光条）

---

## [v3.0.2] - 2026-08-23

### 新增
- **v17真液态玻璃效果全面重写**：参考用户提供的液态玻璃实现，采用大blur(20-28px)+1px边框+多层阴影(外阴影+inset顶部白边+inset底部暗边)+saturate(180%)+顶部1px细高光条的真实玻璃质感
- **四级玻璃层级**：LE悬浮层(28px blur/0.72填充)、L1导航层(24px blur/0.55填充)、L2内容层(24px blur/0.60填充)、L3元素层(20px blur/0.55填充)
- **多层阴影组合（精髓）**：外投射阴影+内顶部高光白边+内底部暗边（暖金色调rgba(120,90,30,0.04-0.06)），三层缺一不可才有厚度感
- **::before只做顶部1px细高光条**：`top:0; left:10%; right:10%; height:1px; linear-gradient`，不做覆盖全区域的大渐变
- **移除::after大面积渐变**：inset阴影已在box-shadow中，不需要额外伪元素
- **移除isolation:isolate**：避免层叠上下文问题
- **移除z-index:3内容层叠调整**：不需要了（没有覆盖全区域的伪元素）

### 修复
- **所有玻璃元素必须有border:1px solid**：参考文件关键细节，1px半透明白边框(rgba(255,255,255,0.35-0.55))
- **blur值大幅提升**：从之前的8-16px改为20-28px大blur，真正的毛玻璃透镜感
- **saturate统一180%**：增强色彩饱和度，玻璃下的内容更鲜艳
- **分隔线用暖色**：`rgba(120,90,30,0.08)`暖金色分隔线，不是白色
- **el-drawer不加position:relative或isolation:isolate**：避免破坏Element Plus默认的position:fixed定位
- **抽屉阴影方向正确**：右侧抽屉左侧投影，左侧抽屉右侧投影

### 移动端适配全面重做
- **弹窗居中显示**：移动端margin:16px，宽度calc(100%-32px)，圆角18px，非底部sheet
- **抽屉宽度88%**：移动端左右抽屉宽度88%，圆角20px
- **玻璃元素移动端圆角减小**：卡片16px，弹窗18px，抽屉20px
- **触控目标最小44px**：所有按钮min-height:44px
- **内边距移动端减小**：弹窗header/body/footer内边距适配
- **导航栏移动端适配**：圆角16px，高度52px，max-width:calc(100%-16px)
- **通知Toast移动端适配**：宽度calc(100%-32px)，左右16px边距
- **overflow-x:hidden**：防止水平溢出
- **底部dock栏安全区域**：env(safe-area-inset-bottom)适配

### 修改文件
- `src/styles/main.css`（v17玻璃材质系统重写、移动端全面适配、深色档同步更新）
- `src/components/NavBar.vue`（L1层玻璃参数、移除大渐变、移动端汉堡菜单44px）
- `src/components/MobileTabBar.vue`（L1层dock玻璃、顶部1px高光、安全区域适配）
- `src/views/HomeView.vue`（Hero L1玻璃、卡片L2/L3玻璃、移除::after流光、art-card高光条）

---

## [v3.0.1] - 2026-08-22

### 修复
- **移动端底栏真正悬浮**：彻底重做MobileTabBar，实现iOS 26风格floating capsule dock——底部32px+左右24px留白，不贴屏幕边缘，宽度自适应内容（fit-content）
- **移除emoji图标**：所有底栏图标改为精致SVG线性图标（学术雅致风格），墨金学术模式禁用表情图标
- **严格遵循铁律14**：玻璃材质系统从错误的0.38~0.50"白瓷不透光"改回正确的L1=0.08/L2=0.10/L3=0.12极薄玻璃
- **移除inset顶部釉光**：删除所有`inset 0 0.5px 0.5px`和`inset 0 1px 0`顶部高光（矩形边框根因）
- **亮边系统**：使用`0 0.5px 0 0 rgba(255,255,255,0.45~0.65)`亮边模拟玻璃边缘反光
- **blur值修正**：从错误的32~48px改回铁律规定的12px，saturate=180%（透镜感而非磨砂）
- **背景纸纹真正透出**：zg-bgimg opacity从0.25提升到0.9，纸纹纹理成为背景主角
- **光晕收敛**：背景金色光晕大幅减弱（0.22→0.10），浮动光球只保留2个且极淡，更克制高级
- **柔影系统**：三层柔影只"浮"不"框"——近距接触影+中距浮影+远距环境影，无硬边
- **NavBar玻璃修正**：导航栏从0.85厚白瓷改为L1导航层0.08薄玻璃
- **滑动透镜精确对齐**：使用JS+ResizeObserver动态测量，选中项金色透镜永远精确跟随
- **底部留白足够**：页面底部padding从64px增加到100px+safe area，不会被悬浮dock遮挡
- **删除旧全局样式**：清理main.css中旧的tabbar全局padding覆盖，避免组件样式冲突

### 修改文件
- `src/components/MobileTabBar.vue`（完全重写：真正悬浮dock+SVG图标+精确滑动透镜）
- `src/styles/main.css`（玻璃token回退铁律14正确值、背景修正、清理旧样式）
- `src/views/HomeView.vue`（Hero/卡片玻璃参数修正）
- `src/components/NavBar.vue`（导航栏L1薄玻璃）
- `src/App.vue`（底部padding调整为悬浮dock留空间）

---

## [v3.0.0] - 2026-08-22

> 里程碑：墨金学术主题 + 全站液态玻璃质感正式上线（此前 v2.1.x 为经典暖橘单主题）。

### 新增
- **墨金学术主题（双档）**：`designMode=inkgold` + `inkgoldTone=light/dark`，超级管理员后台可切换，全站全用户生效（浅色暖米白 #FAF8F4 + 沉稳金 #BA7517；深色温润暖黑 #1B1710）。
- **全站液态玻璃材质系统 v7**：对标 Apple / OPPO / vivo / 华为 / 小米级真柔光玻璃。三级材质 L1/L2/L3（`--zg-glass-1/2/3` 几乎透明 0.08~0.12 + blur 10~12px + 明显亮边 0.6~0.7），多层柔影只「浮」不「框」，移除所有静态面板的 `--zg-rim` 发丝金边（矩形界限根因）。
- **主题背景图**：`public/bg/inkgold-paper.svg`（浅）/ `inkgold-paper-dark.svg`（深），网格 + 光斑 + 丝光纹理，玻璃透出其质感。
- **自托管衬线字体**：`public/fonts/noto-serif-sc-{600,700,800}.woff2`（Noto Serif SC 简体中文，零 CDN 依赖），墨金 Hero 标题用高级衬线。
- **渐变文字**：`.zg-grad-text` 用于导航栏「追光」与首页 Hero 问候/站名，统一高级渐变质感。

### 修复
- **Bug14 输入框金色直角矩形边框**：`:focus-visible` 的 `outline` 不跟随 `border-radius`，改为排除 `.el-input__wrapper / .el-textarea__inner / .el-select__wrapper / .el-input__inner`（commit `3e3bc9d67f`）。
- **Bug15 弹窗 header/footer 灰色矩形条**：`.el-dialog__header/__footer` 灰色渐变背景改为 `transparent`。
- **Bug16 Hero 仍显矩形边框**：移除原 `box-shadow: inset 0 1px 0` 顶部釉光（像边框），改为 `box-shadow: none` + `border-radius:0` 开放釉光区。
- **Bug17 墨金深浅两档 CSS 特异性**：深档选择器必须为 `html.zg-inkgold.zg-inkgold-dark`（特异性 ≥ 浅档 `html.zg-inkgold`），否则深档变量永不生效（曾致深底深字不可读）。

### 修改文件
- `src/styles/main.css`（玻璃 token 块、`.zg-grad-text`、`:focus-visible`、弹窗透明化、深档变量块）
- `src/views/HomeView.vue`（Hero 开放化、美文卡/快捷入口/学科 chip 改 L2/L3 液态玻璃、移动端适配）
- `src/store/theme.ts`、`src/views/admin/ThemeView.vue`（深浅档开关）
- `public/bg/inkgold-paper.svg`、`public/bg/inkgold-paper-dark.svg`、`public/fonts/noto-serif-sc-*.woff2`
- 上线 hash：`style-B41jgASM.css`（部署链 v4→v5→输入修复→v6→v7）

---

## [v2.1.19] - 2026-08-16

### 文档完善
- **全量文档更新**：所有 md 文件和 txt 提示词同步更新，版本号统一为 v2.1.19
- **域名统一**：所有文档中混用的域名统一，确认正确 API 地址为 `api.xkzg.dpdns.org`，用户访问地址为 `xkzg.de5.net`
- **DEPLOY_CHECKLIST.md 重写**：从已废弃的 Render 部署方案重写为 Cloudflare Workers + D1 + Pages 部署清单
- **交接文档更新**：版本号、架构演进表、文档更新记录同步
- **提示词合并重写**：两个提示词文件合并为一个，详细说明项目规则、必读文档、铁律和操作流程

### 修复
- **Cloudflare Pages 构建失败**：移除 `@vitejs/plugin-legacy@8.2.3`（要求 vite@^8 与项目 vite@5 冲突）
- **清理液态玻璃残留代码**：删除 `theme.ts` 中 `visualMode`/`setGlobalVisualMode`、`ThemeView.vue` 中界面风格切换 UI、`App.vue` 中 localStorage 兜底逻辑
- **修复 API 域名错误**：`src/api/http.ts` 默认 API 地址回退为 `https://api.xkzg.dpdns.org`

### 修改文件
- `README.md`、`CHANGELOG.md`、`FAQ.md`、`CONTRIBUTING.md`、`DEPLOY_CHECKLIST.md`
- `交接文档.md`、`给新AI维护者的提示词_首条消息必贴.txt`
- `工作日志_追光学科共享平台.md`、`开发工作日志_追光平台.md`
- `src/store/theme.ts`、`src/views/admin/ThemeView.vue`、`src/App.vue`
- `package.json`、`package-lock.json`

---

## [v2.1.18] - 2026-08-14

### 修复
- **× 关闭按钮消失问题**：此前 `transition: opacity .2s` + 悬停 `opacity: .6` 导致 MessageBox 的 × 默认不可见。改为 `opacity: 1` 强制可见、`display: flex` 居中、字号 18→20px。
- **通知中心（el-drawer）发黄诡异**：此前 drawer 无自定义背景，遮罩层 `rgba(0,0,0,0.4)` + `backdrop-filter` 叠加导致发黄脏色。给 `.el-drawer` / `.el-drawer__body` 加实色 `#FFFBEB` 暖背景 + 左侧柔和阴影；header 加分层+分割线；关闭按钮统一风格。无圆角（按用户要求）。

### 修改文件
- `src/styles/main.css`

---

## [v2.1.17] - 2026-08-14

### 修复
- **所有弹窗 × 关闭按钮统一风格**：此前 `.el-dialog__headerbtn` 有自定义样式但 `.el-message-box__headerbtn` 完全没有覆盖（"群发通知"等 MessageBox 弹窗用 EP 默认灰色 40×40 样式，与 el-dialog 格格不入）。现在两者统一：无背景、无圆圈、极简线条、颜色匹配标题色、悬停仅变色不变背景，参考用户提供的图二风格。

### 修改文件
- `src/styles/main.css`

---

## [v2.1.16] - 2026-08-14

### 重构
- **弹窗样式全面重构为 macOS 风格**：放弃半透明毛玻璃路线（alpha 0.55 导致全透明异常），改回实色暖渐变背景保证可读性。
- **遮罩层**：暗化至 `rgba(0,0,0,0.4)` + `blur(8px)`，建立明暗对比让弹窗浮出。
- **弹窗本体**：实色 `linear-gradient(145deg,#FFFBEB,#FEF3C7)` 暖渐变背景 + 白色高光边框 + 多层柔和阴影（`0 12px 40px` + `inset 0 1px 0`），参考 macOS 悬浮质感。
- **关闭按钮修正**：`position:absolute; top:20px; right:20px; z-index:10` 确保正确定位到右上角；32px 圆形、`line-height` 居中（去掉导致定位异常的 `display:flex`）；悬停半透明主色背景高亮。
- **所有弹窗正中居中**：`.el-overlay-dialog` / `.el-overlay-message-box` flex 居中 + `margin:auto` 双保险。
- **header/footer 微渐变分层**：上下渐变过渡，增强层次感。

### 修改文件
- `src/styles/main.css`

---

## [v2.1.15] - 2026-08-14

### 优化
- **弹窗高斯模糊效果增强**：弹窗背景透明度从 0.82 降至 0.55，让 `backdrop-filter: blur()` 真正透出高斯毛玻璃质感；MessageBox 同步调整。
- **遮罩层修正**：颜色从 `rgba(40,25,0,0.35)` 暗褐色改为 `rgba(0,0,0,0.25)` 中性黑，避免在暖色主题下产生脏黄褐色；模糊从 `3px` 提升至 `8px`。
- **关闭按钮美化**：改为 36px 圆形按钮，× 字号 18→22px、字重 300 更纤细，悬停时半透明主色背景高亮 + × 变主色。

### 修改文件
- `src/styles/main.css`

---

## [v2.1.14] - 2026-08-14

### 修复
- **Cloudflare 构建失败修复**：移除冗余依赖 `@vitejs/plugin-legacy@8.2.3`，该包要求 `vite@^8.0.0` 与项目 `vite@^5` 产生 peer 冲突，导致 Cloudflare 环境下 `npm ci` 直接 ERESOLVE 报错。该依赖在 `vite.config.ts` 及全项目源码中均无引用，移除不影响任何功能。
- **Element Plus 弹窗样式彻底修复**：此前多次修改"毫无改观"的根因是使用了 Element UI 1.x 的旧类名 `.el-dialog__wrapper` / `.el-message-box__wrapper`，而 Element Plus 2.x 真实居中容器类名为 `.el-overlay-dialog` / `.el-overlay-message-box`，旧类名在 DOM 中不存在，故 flex 居中规则完全不生效。

### 变更
- **居中**：对真实容器 `.el-overlay-dialog` / `.el-overlay-message-box` 使用 flex 居中；`.el-dialog` / `.el-message-box` 用 `margin:auto` 覆盖默认 `15vh auto 50px`，内容超高时 auto 边距归零、顶部可见可滚动。
- **毛玻璃**：`backdrop-filter: blur(var(--zg-blur)) saturate(180%)`，模糊强度跟随「界面风格」滑块（由 `store/theme.ts` 的 `applyTheme` 动态注入 `--zg-blur`）。
- **圆角**：`border-radius: var(--zg-radius)`，圆角大小跟随「界面风格」滑块。
- **遮罩层**：`.el-overlay` 增加轻微模糊 + 暗色半透明背景，增强毛玻璃观感。
- **设计美感**：header/footer 分层半透明背景、分割线、关闭按钮悬停高亮、统一阴影圆角。
- **宽度适配（不再弄坏其他弹窗）**：删除此前强制 `width:min(600px,92vw)` 的写法，尊重每个弹窗自带的 `width` prop，仅设 `max-width:92vw` 防溢出；移动端收窄为 92%/88%。
- **移动端**：移除错误的 `.el-dialog__wrapper` 和 `transform: translate(-50%,-50%)` hack，居中统一由全局 flex 处理。

### 修改文件
- `src/styles/main.css`

---

## [v2.1.13] - 2026-08-13

### 新功能
- **Markdown 空格保留支持**
  - 新增 `renderMarkdownPreserveSpaces` 函数
  - 公告栏和页脚文字保留空格和换行符
  - 将 `<p>` 标签替换为 `<br>` 以正确显示格式

### 修改文件
- `src/utils/markdown.ts`
- `src/views/HomeView.vue`

---

## [v2.1.12] - 2026-08-12

### 概述

**修复删除美文时评论经验值未回收的 bug。** 删除美文时只删除了 article 和 like 的经验值记录，没有删除 comment 的记录。

### 变更

- **删除逻辑修复**：在 SQL 查询中添加 'comment' 到 action_type 过滤条件
- **修改文件**：`server/index.ts`、`worker-api.ts`

### 代码修改

- `server/index.ts` - 删除美文时同时删除评论经验值记录
- `worker-api.ts` - 删除美文时同时删除评论经验值记录

---

## [v2.1.10] - 2026-08-11

### 概述

**修复经验值说明页面显示删除规则的问题。** 之前修改了错误的文件（ExpDocView.vue），实际页面使用的是 GuideView.vue。

### 变更

- **GuideView.vue**：移除删除/取消类规则（article_delete、like_cancel等），只显示获取经验的规则
- **说明文字**：更新提示文字，说明删除/取消类操作将直接删除相关经验值记录

### 代码修改

- `src/views/GuideView.vue`

---

## [v2.1.9] - 2026-08-11

### 概述

删除经验值说明界面和管理员设置界面中的回收规则显示。

### 变更

- **经验值说明界面**：删除删除/取消类规则，只显示获取经验的规则
- **管理员设置界面**：删除删除/取消类规则，只显示获取规则的输入框
- **回收规则**：删除内容时直接删除相关经验值记录，无需单独配置

### 代码修改

- `src/views/ExpDocView.vue`（错误文件）
- `src/views/admin/ExpRulesView.vue`

---

## [v2.1.8] - 2026-08-11

### 概述

修改删除美文时的经验值处理逻辑。

### 变更

- **删除美文时**：直接 `DELETE` 相关的经验值记录，不再添加负向的"回收"记录
- **界面显示**：经验值记录只显示原始操作记录，删除后记录直接消失

### 代码修改

- `worker-api.ts`
- `server/index.ts`

---

## [v2.1.7] - 2026-08-10

### 概述

修复删除美文时点赞数不一致问题。

### 变更

- 删除前先统计并修正 `likes` 计数

### 代码修改

- `worker-api.ts`
- `server/index.ts`

---

## [v2.1.6] - 2026-08-10

### 概述

经验值系统测试验证。

### 变更

- 点赞功能测试：用户点赞美文后经验值正确增加（+1）
- 取消点赞测试：用户取消点赞后经验值正确回收（-1）
- 删除美文测试：删除美文后相关经验值正确回收

---

## [v2.1.11] - 2026-08-12

### 修复
- **删除美文时评论经验值未回收的 bug**
  - 问题：删除美文时只删除了 article 和 like 的经验值记录，没有删除 comment 的记录
  - 修复：在 SQL 查询中添加 'comment' 到 action_type 过滤条件
  - 修改文件：`server/index.ts`, `worker-api.ts`

## [v2.1.12] - 2026-08-12

### 新功能
- **Markdown 编辑器支持**
  - 网站公告栏支持 Markdown 格式
  - 页脚文字支持 Markdown 格式
  - 管理后台添加 Markdown 使用说明
  - 前端使用 marked 库渲染 Markdown

### 修改文件
- `src/views/admin/SiteConfigView.vue`
- `src/views/HomeView.vue`
