# ===== 追光 · 学科共享平台 —— Koyeb/Docker 部署 =====
# 多阶段构建：builder 阶段用大内存编译，runner 阶段只保留运行所需文件

# ---- 阶段1：构建 ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# 跳过 vue-tsc 类型检查，直接 vite build（省内存、省时间，适配 Koyeb 512MB 限制）
RUN npx vite build

# ---- 阶段2：运行 ----
FROM node:20-slim AS runner
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/tsconfig.json ./tsconfig.json
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
