# Ovideo 部署（Compute Engine 单机 + Docker Compose）

线上：`https://wangrui.computer` · VM `ovideo`（`asia-east1-b`，e2-standard-2，100GB）· 静态 IP `35.201.179.130`

## 为什么不用 Cloud Run

Ovideo 用 **Prisma + SQLite**，还带一个写库的任务队列。Cloud Run 上唯一的持久化选择是 GCS FUSE 卷，
而 **GCS FUSE 不支持 SQLite 需要的文件锁**，且每次事务都要整对象重写 —— 并发写下数据库损坏是迟早的事。
另外视频合成是长任务，Cloud Run 请求最长 60 分钟。所以这里用**真实磁盘的虚拟机**。

（同域的 Starstudio 能跑 Cloud Run，是因为它只读写 JSON 文件，不是数据库。）

## 架构

```
Caddy(443, 自动 TLS + Basic Auth 口令闸)
  ├── /api/*      → reverse_proxy server:8787
  ├── /storage/*  → reverse_proxy server:8787   （生成的图/音/视频）
  └── 其余         → 内置 SPA（/srv，回退 index.html）
server(8787)  Fastify + Prisma
  ├── /data/ovideo.db                    ← 卷 ovideo-db（SQLite）
  └── /app/apps/server/storage           ← 卷 ovideo-storage（媒体，STORAGE_ROOT）
```

前端用的是**相对路径** `/api`、`/storage`，所以同源部署即可，**无需改任何应用代码**。

## 首次部署 / 重建

```bash
# 1. 打包上传（排除 node_modules/.git/本地 .env/本地 db）
tar czf ovideo.tar.gz --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' \
    --exclude='*/dist' --exclude='./apps/server/storage' --exclude='*.db' \
    --exclude='./apps/server/.env' --exclude='./.claude' .
gcloud compute scp ovideo.tar.gz ovideo:/tmp/ --zone asia-east1-b
gcloud compute ssh ovideo --zone asia-east1-b --command='sudo mkdir -p /opt/ovideo && sudo tar xzf /tmp/ovideo.tar.gz -C /opt/ovideo && sudo chown -R $USER:$USER /opt/ovideo'

# 2. 配置域名 + 口令闸（生成 bcrypt 并写进 Caddyfile）
cd /opt/ovideo/deploy
printf 'OVIDEO_DOMAIN=wangrui.computer\n' > .env
PW=$(openssl rand -base64 15)
HASH=$(sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext "$PW")
sed -i "s|{\$OVIDEO_USER} {\$OVIDEO_PASSWORD_HASH}|franklin ${HASH}|" Caddyfile
echo "$PW"   # 记下来，这是登录密码

# 3. 起服务
sudo docker compose up -d --build
```

> **口令为什么写进 Caddyfile 而不是 .env**：bcrypt 哈希以 `$2a$...` 开头，
> `$` 会和 docker-compose 的变量插值打架。写进 Caddyfile 最稳。

## 更新代码

```bash
# 本地重新打包上传（同上第 1 步），然后：
cd /opt/ovideo/deploy && sudo docker compose up -d --build
```

`.env`、`Caddyfile` 里的凭据和两个数据卷都不会被覆盖。

## DNS（根域直达，无子域）

在 GoDaddy（`wangrui.computer` 的 NS 是 ns27/28.domaincontrol.com）把**根域**指到这台机器：

1. **删掉** `@` 现有的 4 条 A 记录（`216.239.32.21` / `.34.21` / `.36.21` / `.38.21` —— 失效的 Google 域名转发）
2. **删掉** `@` 现有的 AAAA 记录（`2001:4860:4802:3x::15`）—— **必须删**，否则支持 IPv6 的浏览器仍会走到 Google 那个死地址
3. **新增**：

| 类型 | 名称 | 值 | TTL |
|---|---|---|---|
| A | `@` | `35.201.179.130` | 600 |

4. `www` 同样指向 Google，按需删掉或改成 A → `35.201.179.130`

加完 Caddy 会自动签发 Let's Encrypt 证书（每 60 秒重试一次，最长重试 30 天）。

> **不受影响**：`star.wangrui.computer`（Starstudio）是独立的子域记录，改根域不会动到它。
>
> 根域**只能用 A 记录**（CNAME 在 apex 不合法），正好这台是虚拟机有固定 IP。
> 而 `star` 用的是 CNAME → `ghs.googlehosted.com`，那是 Cloud Run 专用，别照抄。

## 排障

```bash
cd /opt/ovideo/deploy
sudo docker compose ps
sudo docker compose logs server --tail=50    # 后端
sudo docker compose logs caddy  --tail=50    # 证书签发情况
```

**已踩过的坑**：builder 阶段必须在 `prisma generate` 之前装 `openssl`。否则 Prisma
探测不到 libssl，会按 `debian-openssl-1.1.x` 生成查询引擎，而运行阶段需要 `3.0.x`，启动即崩。

## 模型 API Key

不走环境变量 —— 上线后在应用内「管理后台 → API 厂商配置」填入，存在 SQLite 里。
