# 更新日志（CHANGELOG）

> 本文件记录「追光 · 学科共享平台」所有版本的变更内容，按时间倒序排列。
> 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

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
