# 更新日志（CHANGELOG）

> 本文件记录「追光 · 学科共享平台」所有版本的变更内容，按时间倒序排列。
> 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

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
