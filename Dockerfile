# ===== 追光 · 学科共享平台 —— Docker 部署 =====
# 直接使用仓库中预构建的 dist/，跳过构建，避免内存限制

FROM node:20-slim
WORKDIR /app

# 仅安装生产依赖（tsx 已在 dependencies 中）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制项目文件（包含预构建的 dist/ 和服务端代码）
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npx", "tsx", "server/index.ts"]

