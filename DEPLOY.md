# 德州扑克 · 公网部署指南

本项目基于 **Node.js + Express + Socket.IO**，支持 2-7 人实时联机。要让朋友通过公网访问，需要将服务部署到具备公网访问能力的环境。

## 目录

- [方案选择](#方案选择)
- [方案一：云服务器直接部署（推荐）](#方案一云服务器直接部署推荐)
- [方案二：Docker 部署](#方案二docker-部署)
- [方案三：内网穿透（无需公网 IP，快速测试）](#方案三内网穿透无需公网-ip快速测试)
- [方案四：家庭宽带 + 端口转发](#方案四家庭宽带--端口转发)
- [域名与 HTTPS 配置](#域名与-https-配置)
- [安全加固建议](#安全加固建议)
- [故障排查](#故障排查)

---

## 方案选择

| 方案 | 适用场景 | 难度 | 公网 IP |
|------|---------|------|---------|
| 云服务器 | 长期稳定运行，推荐 | 中 | 有（云厂商提供） |
| Docker | 已有 Docker 环境，快速部署 | 低 | 有（或配合穿透） |
| 内网穿透 | 临时测试、没有公网 IP | 低 | 无需 |
| 端口转发 | 家庭宽带且有公网 IP | 中 | 有（需运营商分配） |

> **提示**：国内家庭宽带大多是 **大内网（CGNAT）**，无法做端口转发。请先在 [ipip.net](https://www.ipip.net) 查看你的公网 IP，再登录路由器 WAN 口比对，若不一致就是 CGNAT，推荐用方案一或方案三。

---

## 方案一：云服务器直接部署（推荐）

购买任意云服务器（阿里云/腾讯云/华为云/AWS/Vultr 等），系统建议 **Ubuntu 22.04** 或 **CentOS 7+**。

### 1. 安装 Node.js

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 验证
node -v   # 应显示 v20.x
npm -v
```

### 2. 上传项目代码

将整个项目目录上传到服务器，例如 `/opt/poker`：

```bash
# 方式一：scp（在本地执行）
scp -r ./temp_20261031_01 user@your-server-ip:/opt/poker

# 方式二：git clone（若已推送到仓库）
git clone <你的仓库地址> /opt/poker
```

### 3. 安装依赖并启动

```bash
cd /opt/poker
npm install --omit=dev --no-audit --no-fund
```

### 4. 用 PM2 后台运行（推荐）

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 按提示执行输出的命令，实现开机自启
```

常用命令：

```bash
pm2 list          # 查看进程
pm2 logs poker    # 查看日志
pm2 restart poker # 重启
pm2 stop poker    # 停止
```

### 5. 开放防火墙端口

```bash
# Ubuntu (ufw)
sudo ufw allow 3000/tcp

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

**云服务器安全组**：登录云厂商控制台，在安全组规则中放行 **3000 端口（TCP）**。

### 6. 验证访问

浏览器打开 `http://你的服务器公网IP:3000`，能看到登录页面即成功。

---

## 方案二：Docker 部署

项目已提供 `Dockerfile` 和 `docker-compose.yml`。

### 1. 安装 Docker

```bash
# Ubuntu
curl -fsSL https://get.docker.com | sudo bash
sudo systemctl enable --now docker
```

### 2. 构建并运行

```bash
cd /opt/poker
sudo docker compose up -d --build
```

### 3. 验证

```bash
sudo docker compose ps       # 查看容器状态
sudo docker compose logs -f  # 查看日志
```

访问 `http://服务器IP:3000` 即可。

> 如需停止：`sudo docker compose down`

---

## 方案三：内网穿透（无需公网 IP，快速测试）

如果你没有公网 IP，可以用内网穿透工具将本地服务暴露到公网。

### 选项 A：ngrok（最简单，国外）

```bash
# 下载 ngrok: https://ngrok.com/download
# 注册后获取 authtoken
ngrok config add-authtoken <你的token>
ngrok http 3000
```

ngrok 会返回一个公网地址，如 `https://abc123.ngrok-free.app`，分享给朋友即可。

### 选项 B：cpolar（国内，速度快）

```bash
# 下载: https://www.cpolar.com
cpolar http 3000
```

### 选项 C：frp（自建，需一台有公网 IP 的服务器）

在有公网 IP 的服务器上运行 frps，本地运行 frpc 转发 3000 端口。

**注意**：Socket.IO 使用 WebSocket，穿透工具需支持 WebSocket 转发（上述工具均支持）。

---

## 方案四：家庭宽带 + 端口转发

仅适用于有**公网 IP** 的家庭宽带。

### 1. 确认有公网 IP

在 [ipip.net](https://www.ipip.net) 查到的 IP 与路由器 WAN 口 IP 一致，即为公网 IP。

### 2. 路由器端口转发

登录路由器管理后台 → 转发规则/虚拟服务器：

| 外部端口 | 内部 IP | 内部端口 | 协议 |
|---------|---------|---------|------|
| 3000 | 你的电脑内网 IP | 3000 | TCP |

### 3. 启动服务

```bash
node server.js
```

朋友访问 `http://你的公网IP:3000` 即可。

> ⚠️ 若重启路由器后公网 IP 变化，可配合 DDNS（如花生壳、No-IP）绑定域名。

---

## 域名与 HTTPS 配置

使用域名 + HTTPS 更安全、体验更好（部分浏览器对 WebSocket 要求 HTTPS）。

### 1. 配置 DNS

将域名 A 记录指向你的服务器公网 IP。

### 2. 安装 Nginx

```bash
sudo apt install nginx -y   # Ubuntu
sudo yum install nginx -y   # CentOS
```

### 3. 配置反向代理

参考项目根目录的 [`nginx.conf.example`](./nginx.conf.example)，将其复制到 Nginx 配置目录：

```bash
sudo cp nginx.conf.example /etc/nginx/conf.d/poker.conf
sudo vim /etc/nginx/conf.d/poker.conf   # 将 your-domain.com 改为你的域名
sudo nginx -t                             # 测试配置
sudo systemctl reload nginx
```

> **关键点**：配置中 `proxy_set_header Upgrade $http_upgrade` 和 `Connection "upgrade"` 是 Socket.IO WebSocket 连接的必需项，**不能省略**。

### 4. 申请免费 HTTPS 证书（Let's Encrypt）

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

按提示操作，Certbot 会自动配置 HTTPS 并设置证书自动续期。

完成后访问 `https://your-domain.com` 即可。

---

## 安全加固建议

1. **限制 CORS 来源**（可选）：编辑 `server.js`，将 `cors: { origin: '*' }` 改为你的域名：
   ```js
   cors: { origin: 'https://your-domain.com' }
   ```

2. **防火墙只开放必要端口**：生产环境建议只开 80/443，通过 Nginx 反代到 3000，3000 端口不对外暴露。

3. **服务器安全**：
   - 禁用 root 密码登录，使用 SSH 密钥
   - 安装 fail2ban 防止暴力破解
   - 定期 `apt update && apt upgrade`

4. **游戏层限制**（当前版本未实现，可按需扩展）：
   - 玩家昵称长度/字符校验
   - 单 IP 多开限制
   - 房间人数上限已设为 7 人

---

## 故障排查

| 问题 | 排查方法 |
|------|---------|
| 页面打不开 | 1) `pm2 list` 确认进程运行；2) `curl http://127.0.0.1:3000` 测试本地；3) 检查防火墙/安全组是否放行端口 |
| 能进房间但无法开始 | 浏览器 F12 查看 Console 是否有 WebSocket 连接错误；若用 Nginx，确认 Upgrade 头已配置 |
| WebSocket 连接失败 | 确认穿透工具/反向代理支持 WebSocket；HTTPS 站点不能用 ws:// 连接（需 wss://，Nginx 会自动处理） |
| 多人连不上 | 确认所有人访问的是**公网地址**而非 localhost；检查服务端日志 `pm2 logs poker` |
| 端口被占用 | `lsof -i:3000` 或 `netstat -tlnp | grep 3000` 查看占用进程，修改 `server.js` 中的 PORT |
| Docker 启动失败 | `docker compose logs` 查看详细错误；确认 `package-lock.json` 存在或删除后重建 |

---

## 项目文件说明

| 文件 | 用途 |
|------|------|
| `server.js` | 主服务（Express + Socket.IO） |
| `game/` | 游戏核心逻辑（牌组、手牌评估、牌局状态机） |
| `public/` | 前端页面 |
| `Dockerfile` | Docker 镜像构建 |
| `docker-compose.yml` | Docker Compose 编排 |
| `ecosystem.config.js` | PM2 进程管理配置 |
| `nginx.conf.example` | Nginx 反向代理配置模板 |
