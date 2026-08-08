#!/usr/bin/env bash
# ============================================================================
# 追光 · 学科共享平台 —— 一键部署到 xkzg.dpdns.org (HTTPS)
#
# 用法（在目标公网服务器上，项目根目录执行）：
#   1) 先把域名 xkzg.dpdns.org 的 A 记录解析到本服务器公网 IP
#   2) sudo EMAIL=you@example.com bash deploy.sh
#
# 前置条件：
#   - Ubuntu 20.04+ / Debian 11+（公网服务器，非本沙箱）
#   - 80/443 端口可对外访问
#   - 域名 xkzg.dpdns.org 的 A 记录已指向本机公网 IP
# ============================================================================
set -euo pipefail

DOMAIN="xkzg.dpdns.org"
APP_PORT=3001
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMAIL="${EMAIL:-}"

# 颜色
G="\033[32m"; Y="\033[33m"; R="\033[31m"; B="\033[34m"; N="\033[0m"
ok()    { echo -e "${G}[OK]${N} $1"; }
info()  { echo -e "${B}[..]${N} $1"; }
warn()  { echo -e "${Y}[!!]${N} $1"; }
die()   { echo -e "${R}[ERR]${N} $1"; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 或 sudo 执行：sudo bash deploy.sh"
command -v lsb_release >/dev/null 2>&1 || die "仅支持 Ubuntu/Debian，请使用相应系统。"
info "应用目录: $APP_DIR"
info "目标域名: $DOMAIN"

# ---------- 1. 安装系统依赖 ----------
info "安装 Node.js / nginx / certbot …"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx
ok "系统依赖就绪：node $(node -v), npm $(npm -v)"

# ---------- 2. 安装项目依赖并构建前端 ----------
info "安装项目依赖（npm install）…"
cd "$APP_DIR"
npm install --no-audit --no-fund
ok "依赖安装完成"

if [ ! -d "$APP_DIR/dist" ]; then
  info "构建前端（vite build）…"
  npm run build || npx vite build
  ok "前端构建完成"
else
  ok "dist 已存在，跳过构建（如需重新构建请先删除 dist 目录）"
fi

# ---------- 3. 配置 systemd 服务 ----------
info "配置 systemd 服务 zhuiguang …"
cat > /etc/systemd/system/zhuiguang.service <<EOF
[Unit]
Description=Zhuiguang Platform (追光学科共享平台)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/node_modules/.bin/tsx server/index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zhuiguang
systemctl restart zhuiguang
sleep 2
if curl -s -o /dev/null -w "" "http://127.0.0.1:$APP_PORT/"; then
  ok "zhuiguang 服务已启动（监听 $APP_PORT）"
else
  warn "服务可能未就绪，查看日志：journalctl -u zhuiguang -n 50"
fi

# ---------- 4. 配置 nginx 反向代理 ----------
info "配置 nginx 站点 …"
cat > /etc/nginx/sites-available/zhuiguang.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # 上传文件大小限制（与后端 multer 一致：100MB）
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/zhuiguang.conf /etc/nginx/sites-enabled/zhuiguang.conf
# 移除默认站点避免冲突
[ -f /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "nginx 已配置并重载"

# ---------- 5. 域名解析检查 ----------
info "检查 $DOMAIN 的 A 记录是否指向本机 …"
PUBLIC_IP="$(curl -s --max-time 8 ifconfig.me || curl -s --max-time 8 ipinfo.io/ip || true)"
RESOLVED_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ -n "$PUBLIC_IP" ] && [ -n "$RESOLVED_IP" ] && [ "$PUBLIC_IP" = "$RESOLVED_IP" ]; then
  ok "域名已解析到本机 ($PUBLIC_IP)"
else
  warn "域名解析检测：本机公网IP=$PUBLIC_IP，$DOMAIN 解析=$RESOLVED_IP"
  warn "若二者不一致，请先到 DNS 服务商把 $DOMAIN 的 A 记录指向 $PUBLIC_IP，DNS 生效后重跑本脚本或单独执行 certbot 步骤。"
  echo
  read -r -p "是否仍要继续申请 HTTPS 证书？(y/N) " ans
  [ "$ans" = "y" ] || { info "已跳过证书申请。HTTP 访问已就绪: http://$DOMAIN"; exit 0; }
fi

# ---------- 6. 申请 Let's Encrypt HTTPS 证书 ----------
info "申请 Let's Encrypt 证书 …"
if [ -z "$EMAIL" ]; then
  read -r -p "请输入用于证书注册的邮箱: " EMAIL
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
  certbot --nginx -d "$DOMAIN" --agree-tos -m "$EMAIL" --redirect
ok "HTTPS 证书已签发，并已配置 HTTP→HTTPS 自动跳转"

# ---------- 7. 完成 ----------
echo
echo -e "${G}==================== 部署完成 ====================${N}"
echo -e " 访问地址 : ${B}https://$DOMAIN${N}"
echo -e " 超管账号 : admin / admin123456  （请登录后立即修改密码）"
echo -e " 服务管理 : systemctl {start|stop|restart|status} zhuiguang"
echo -e " 查看日志 : journalctl -u zhuiguang -f"
echo -e " 证书续期 : certbot 已自动设置定时续期"
echo -e " 数据目录 : $APP_DIR/server/zhuiguang.db  与  $APP_DIR/server/uploads/"
echo -e "${G}=================================================${N}"
