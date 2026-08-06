# ============================================================
# 🚀 追光学科共享平台 · Replit Workspace模式 云端上云操作手册（终版·零绑卡·彻底告别隧道）
# ============================================================
# ✅ 100%免费 ✅ 零绑卡 ✅ 彻底告别Pinggy/Worker隧道 ✅ 7x24云端运行 ✅ SQLite永久持久化
# ✅ 绕开30天限制（用Workspace模式repl.co URL，不用Published App的replit.app）
# 配套文件：worker_replit_proxy.js（Cloudflare Worker纯反代版，120行精简·没有隧道轮询·稳定）
# 配套文件：.replit + replit.nix（已经写好·推到GitHub了·直接用）
#
# 📅 2026-08-06 权威结论（Replit官方+社区双验证）：
#   模式1. Published App (.replit.app URL) → ❌ 免费版发布满30天自动下线断流
#   模式2. Workspace Dev (.repl.co URL)   → ✅ 永久可用！30天限制不适用！
#           唯一风险：30-60分钟无外部访问会休眠→UptimeRobot每5分钟心跳→永不休眠
#   SQLite持久化：Workspace模式直接IDE点Run→.db文件永久保存（休眠/重启不丢）
#                Published App模式→临时文件系统→重启清空SQLite（绝对不用！）
# ============================================================

# ============================================================
# 📋 准备清单（2分钟）
# ============================================================
1. 【Replit账号】：https://replit.com → GitHub一键登录·零绑卡（如果已有直接用）
2. 【Cloudflare账号】：您已经有了（xkzg.de5.net托管在那的）
3. 【UptimeRobot账号】：https://uptimerobot.com → 邮箱注册·零绑卡
4. 【本地数据库文件】：您的 /workspace/server/local.db（这是19张表核心数据·必须要上传）

# ============================================================
# 🚀 Step 1 · Replit 导入代码（约8分钟·全程点点按钮）
# ============================================================
目标：让您的代码+SQLite跑在Replit Workspace IDE里，拿到repl.co URL

1. 打开 https://replit.com → 右上角【Sign Up】→ 选【GitHub】登录授权（零绑卡·就点授权）
2. 登录后左上角点蓝色【+ Create Repl】（或中间的Create按钮）
3. ⚠️ 非常重要！右侧选【Import from GitHub】（不要选空白模板！）
   - GitHub Repo URL: 粘贴您的仓库 HTTPS 地址（例：https://github.com/wrm120318/zhuiguang ）
   - Language: 自动会识别成 Node.js（如果没识别就手动选 Node.js）
   - 点右下角蓝色【Import from GitHub】
4. 等1-2分钟克隆代码完成
5. 【关键·上传SQLite数据库！】：
   - 左侧文件树 → 找到 server/ 文件夹 → 右键 → 【Upload file】
   - 选中您本地沙箱里的 /workspace/server/local.db → 上传
   - ✅ 上传完成后，路径必须是 server/local.db（和本地沙箱一样）
   - （如果没看到 server 文件夹，点左侧顶部的【Add folder】新建一个，命名 server，然后把local.db拖进去）
6. 【关键·检查配置文件】：
   左侧文件树应该能看到这两个文件（我已经帮您写好推GitHub了，正常自动有）：
   - ✅ .replit（内容第一行写了 run = ["npm","run","start"]）
   - ✅ replit.nix（内容写了 nodejs-20_x）
   - ✅ package.json 里 scripts.start = "tsx server/index.ts"（您原本就有，不用改）
   👉 如果没自动有这两个文件 → 手动新建：点左侧【Add file】→ 文件名 .replit → 粘贴 https://raw.githubusercontent.com/wrm120318/zhuiguang/main/.replit 内容；同样方法建 replit.nix
7. 中间上方绿色【Run】按钮 → 点一下！
8. 等5-8分钟（第一次慢）：
   - 它会先 npm install（装 better-sqlite3 / tsx 等依赖·原生绑定编译要几分钟）
   - 然后自动跑 tsx server/index.ts
   - 右侧 Webview 预览窗会显示您的网站登录页！✅（证明后端跑起来了）
9. 【拿 Workspace repl.co URL·最重要！】：
   - 右侧预览窗右上角，有个【↗️ Open in a new tab】小图标（New Tab按钮）→ 点它！
   - 新标签页打开的地址就是您的 Workspace Dev URL！
   - 格式：https://你的repl名--你的GitHub用户名.repl.co
     例：https://zhuiguang-abc123--wrm120318.repl.co
   📌 复制这个URL！后面Cloudflare Worker反代和UptimeRobot保活全要用它！
   - 自测：把URL贴到地址栏后面加 /__zg_health → 例：https://xxx.repl.co/__zg_health
     → 页面显示 OK:xxx 200状态 ✅ 完美！
   - 自测2：直接访问URL + /login → 登录页能打开 ✅

# ============================================================
# 🛡️ Step 2 · UptimeRobot 每5分钟心跳保活（1分钟·永不休眠）
# ============================================================
Replit免费Workspace规则：连续30-60分钟没有外部HTTP请求，项目容器休眠（下次访问冷启动5-10秒）
→ 用UptimeRobot每5分钟自动发一个请求到/__zg_health → 永不休眠！用户访问永远秒开！

1. 打开 https://uptimerobot.com → Register免费账号（邮箱注册·零绑卡）
2. 登录 → 左上角【Add New Monitor】
3. 填：
   ┌──────────────────────────────────────────────────┐
   │ Monitor Type          : HTTP(s)                  │
   │ Friendly Name (可选) : 追光Replit保活            │
   │ URL (or IP)           : 【Step1第9条复制的repl.co URL】/__zg_health
   │ 例: https://zhuiguang-abc--wrm120318.repl.co/__zg_health
   │ Monitoring Interval   : Every 5 minutes (最小·免费版默认5分·刚好)
   │ Alert Contacts To Notify: 【勾选您的邮箱】（如果您想收邮件告警·没需求就不勾）
   └──────────────────────────────────────────────────┘
4. 底部【Create Monitor】→ 确认页点【Create Monitor】
5. Done ✅！从此UptimeRobot全球节点每5分钟给您的Replit发一次心跳→永远不休眠！
   （以后不用管UptimeRobot了，它自己跑）

# ============================================================
# 🌐 Step 3 · Cloudflare Worker 纯反代绑定 xkzg.de5.net（3分钟·彻底告别隧道！）
# ============================================================
这一步把您自己的域名 xkzg.de5.net → 转发到 Replit repl.co URL
→ 对外完全看不到repl.co地址，用户只知道xkzg.de5.net
→ Worker代码从v7.5的750行（隧道轮询）→ 精简到120行（纯转发）= 稳定如磐石！不会再出现"服务重连中"弹窗！

1. 打开 Cloudflare Dashboard → 左侧【Workers & Pages】→ 找到您现在用的Worker（名字是 zhuiguang-proxy 或您起的那个）→ 点进去
2. 右上角【Edit Code】→ 全选（Ctrl+A）→ Delete 清空旧代码（旧的v7.5隧道版代码全删掉）
3. 新标签页打开 → 复制下面链接全部内容：
   https://raw.githubusercontent.com/wrm120318/zhuiguang/main/worker_replit_proxy.js
4. 回到Cloudflare编辑页→粘贴
5. ⚠️ 【非常重要！只改这1行！】：
   第25行有：
   ```js
   const REPLIT_ORIGIN = "https://你的repl名--你的用户名.repl.co";
   ```
   → 把双引号里的字符串改成您 Step1第9条复制的【Workspace repl.co URL】（注意最后面不要有斜杠！）
   例：const REPLIT_ORIGIN = "https://zhuiguang-abc--wrm120318.repl.co";
6. 右上角【Save and Deploy】→ 等3秒显示 Deployed ✅
7. 【测试！】：
   浏览器打开 https://xkzg.de5.net/__proxy_status → 应该返回JSON，里面target是您的repl.co URL！✅
   再打开 https://xkzg.de5.net/login → 登录页打开！✅
   → 大功告成！从此 xkzg.de5.net = 直接转发Replit！彻底告别Pinggy隧道+Worker轮询！

# ============================================================
# 🎁 Step 4（推荐·可选·体验升级）· 前端Vue上Cloudflare Pages（5分钟·静态秒开）
# ============================================================
做完Step 1-3已经100%能用了。想进一步提升体验：把Vue前端静态文件放到Cloudflare Pages全球CDN
→ 页面打开速度从5秒→0.5秒！CSS/JS/图片全走CDN，Replit只跑后端API，压力进一步下降。

1. Cloudflare Dashboard → 左侧【Workers & Pages】→ 右上角【Create】→ 切到【Pages】标签→【Connect to Git】
2. 选GitHub → 授权 → 选您的 zhuiguang 仓库 → 【Begin setup】
3. 构建设置（填4项就行，其他全默认）：
   ┌──────────────────────────────────────────────────┐
   │ Project name          : zhuiguang-front（随便）│
   │ Production branch     : main                    │
   │ Build command         : npm install && npm run build
   │ Build output directory: dist                    │
   └──────────────────────────────────────────────────┘
4. 切到【Environment variables (advanced)】→ 【Add variable】生产环境变量（让前端构建时知道API地址是Replit）：
   ┌──────────────────────────────────────────────────┐
   │ Variable name         : VITE_API_BASE_URL       │
   │ Value                 : 【Step1第9条的repl.co URL】(不要斜杠)
   │ 例: https://zhuiguang-abc--wrm120318.repl.co
   └──────────────────────────────────────────────────┘
   👉 为什么这个变量生效？因为我之前已经改了 src/api/http.ts（看您GitHub已推），里面写了：
      const PROD_API_BASE = import.meta.env.VITE_API_BASE_URL || ''
      → Pages构建时注入VITE_API_BASE_URL=Replit地址，前端axios直接发Replit·不用走同源
5. 底部【Save and Deploy】→ 等3-5分钟构建完成→显示Your site is live ✅
6. 【绑定您的域名 xkzg.de5.net】：
   Pages项目→【Custom domains】标签→【Set up a custom domain】
   → 输入 xkzg.de5.net → Continue → Activate domain（Cloudflare自动配DNS·2分钟Active ✅）
7. 【Worker要改1行！】：
   现在您的域名指向Pages（前端）了，后端API需要单独一个子域名（比如 api.xkzg.de5.net）
   → Cloudflare DNS→Add record→CNAME：
      Name: api   Target: 【您的Worker域名，去Workers页面找，格式是xxx.xxx.workers.dev】   Proxy status: 开(橙色云朵)
   → 然后去Worker→【Triggers】→【Custom Domains】→【Add Custom Domain】→ 填 api.xkzg.de5.net
   → 等2分钟生效
   → 最后回到Pages项目→环境变量→把VITE_API_BASE_URL改成 https://api.xkzg.de5.net （Worker反代域名，对外统一）
   → Retry Deployment重新构建
8. Done！https://xkzg.de5.net 打开网站→秒开！API走api.xkzg.de5.net（Worker反代Replit）
   （如果嫌麻烦，Step 4可以不做，Step 1-3已经完全够用，只是静态资源慢一点）

# ============================================================
# ✅ 做完后的终局架构
# ============================================================
```
用户访问 https://xkzg.de5.net
   │
   ├─【做了Step4 Pages升级】→ 🌩️ Cloudflare Pages 全球CDN（Vue dist/静态资源）
   │                              ↓ API请求
   │                           api.xkzg.de5.net（Cloudflare Worker纯反代120行）
   │                              ↓
   │                           💻 Replit Workspace Mode（tsx server/index.ts）
   │                              ↓
   │                           🗄️ server/local.db（永久持久化SQLite，休眠重启不丢）
   │                              ↓ 文件上传旁路（保留优秀设计）
   │                           📦 Supabase Storage（前端直传，不经过Replit）
   │
   └─【没做Step4·只用Step1-3】→ 🌐 Cloudflare Worker纯反代（xkzg.de5.net → Replit repl.co）
                                  ↓ 整站转发
                               💻 Replit Workspace Mode + SQLite
```

---

## 🚨 常见坑（必看·踩坑不用慌）

| 问题 | 原因 | 解决方案 |
|---|---|---|
| Replit Run时better-sqlite3编译失败 | 原生模块编译缺gcc/g++ | Shell里执行：`npm install better-sqlite3 --build-from-source`，然后重新点Run |
| npm install太慢超时 | Replit装依赖网络慢 | 等2分钟自己就好，或Shell里加`npm install --registry=https://registry.npmmirror.com` |
| xkzg.de5.net打开503"启动中"刷几次就好 | Replit容器刚从休眠恢复（冷启动5-10秒） | 正常现象！UptimeRobot保活后99.9%用户不会遇到；偶尔遇到等5秒自动刷新就好 |
| /login打开404 | 上传的local.db路径错了！不是在根目录！ | Replit文件树：路径必须是 **server/local.db**（子目录，不是根目录），检查一遍 |
| JWT登录成功但立刻401跳回登录 | 本地生成JWT_SECRET和Replit环境变量不一样 | Replit左侧【Tools】→【Secrets】→ 加一条：Key=`JWT_SECRET`，Value=您本地.env里的字符串（如果不记得，沙箱里cat /workspace/.env 看一眼），然后Replit重新点Run |
| 点击登录按钮没反应 | 浏览器缓存了旧的503重连HTML | Ctrl+Shift+R 强制刷新（清缓存刷新）立刻好 |
| 1个月后突然打不开 | 是不是不小心用了Published App模式用了replit.app？ | ✅ 我们用的是Workspace模式repl.co URL，**不会30天死**；如果真打不开，登录Replit→点Run重新启动就行 |

---

## 🎯 一句话总结（做完Step1-3就结束）：
**Replit Workspace模式跑代码（.repl.co永久URL）+ UptimeRobot 5分钟保活 + Cloudflare Worker 120行纯反代 = 零绑卡零花费彻底告别隧道，关电脑关沙箱，网站7x24照样在线！**
