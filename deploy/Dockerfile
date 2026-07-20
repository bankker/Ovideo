# Ovideo 部署镜像（三段式）
#   builder → 装依赖、构建 shared/web、生成 Prisma Client
#   server  → Node + FFmpeg 运行 Fastify 后端（含 DB 迁移）
#   web     → Caddy 镜像内置已构建的 SPA（免去卷同步）

# ---------- builder ----------
FROM node:24-slim AS builder
# openssl 必须在 `prisma generate` 之前装好：否则 Prisma 探测不到 libssl，
# 会按 debian-openssl-1.1.x 生成查询引擎，而运行阶段需要 3.0.x → 启动即崩。
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# 先只拷清单，最大化利用依赖层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json  apps/server/
COPY apps/web/package.json     apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @ovideo/shared build \
 && pnpm --filter @ovideo/web build \
 && pnpm --filter @ovideo/server exec prisma generate

# ---------- server ----------
FROM node:24-slim AS server
# ffmpeg：合成/转码必需；openssl：Prisma 运行时依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY --from=builder /app ./

ENV NODE_ENV=production \
    OVIDEO_SERVER_PORT=8787
EXPOSE 8787

# 每次启动先把迁移推平，再起服务
CMD ["sh", "-c", "pnpm --filter @ovideo/server exec prisma migrate deploy && pnpm --filter @ovideo/server start"]

# ---------- web（Caddy + 内置 SPA） ----------
FROM caddy:2-alpine AS web
COPY --from=builder /app/apps/web/dist /srv
