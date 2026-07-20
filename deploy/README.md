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

## DNS：已迁到 Google Cloud DNS

DNS 原本托管在 GoDaddy，每改一条记录都得人工登录。现已迁到本项目的 Cloud DNS
（区名 `wangrui`），之后**所有记录都能用 gcloud 改，不必再登 GoDaddy**。

迁移安全的前提（迁移前已盘点确认）：该域**没有 MX 记录**，不收邮件，
所以不存在"迁 DNS 搞挂邮箱"这个最大风险。需要保留的只有 `star` 与一条站点验证 TXT。

区内记录：

| 名称 | 类型 | 值 | 用途 |
|---|---|---|---|
| `@` | A | `35.201.179.130` | Ovideo（本机） |
| `www` | A | `35.201.179.130` | Ovideo，Caddy 内跳主域 |
| `star` | CNAME | `ghs.googlehosted.com.` | Starstudio（Cloud Run） |
| `@` | TXT | `google-site-verification=…` | 站点验证 |

> 根域**只能用 A 记录**（CNAME 在 apex 不合法），正好这台虚拟机有固定 IP。
> `star` 用 CNAME → `ghs.googlehosted.com` 是 Cloud Run 专用写法，别套用到根域。

### 一次性：把 GoDaddy 的 nameserver 改到 Cloud DNS

GoDaddy → 我的产品 → `wangrui.computer` → 管理 DNS → 域名服务器 → 更改 → 使用自定义域名服务器：

```
ns-cloud-d1.googledomains.com
ns-cloud-d2.googledomains.com
ns-cloud-d3.googledomains.com
ns-cloud-d4.googledomains.com
```

生效后 GoDaddy 里的记录不再起作用（一切以 Cloud DNS 为准），Caddy 会自动签发证书。

### 以后改记录（不用碰 GoDaddy）

```bash
Z=wangrui; P=gen-lang-client-0542115635
gcloud dns record-sets list --zone $Z --project $P
gcloud dns record-sets create app.wangrui.computer. --zone $Z --project $P --type A --ttl 600 --rrdatas 1.2.3.4
gcloud dns record-sets update wangrui.computer.     --zone $Z --project $P --type A --ttl 600 --rrdatas 5.6.7.8
gcloud dns record-sets delete old.wangrui.computer. --zone $Z --project $P --type A
```

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
