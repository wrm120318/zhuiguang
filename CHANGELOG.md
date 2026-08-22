# 更新日志（CHANGELOG）

> 本文件记录「追光 · 学科共享平台」所有版本的变更内容，按时间倒序排列。
> 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

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
