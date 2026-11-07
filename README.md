# ♠ 德州扑克 · 在线联机版

一个可以 **2-7 人** 同桌联机对战的 Web 端德州扑克游戏。后端用 Node.js + Express + Socket.IO，前端纯 HTML/CSS/JS，无需编译，部署后任何人打开浏览器就能玩。

![stage](https://img.shields.io/badge/stable-yes-green) ![players](https://img.shields.io/badge/players-2--7-blue) ![real-time](https://img.shields.io/badge/realtime-Socket.IO-orange)

---

## 目录

- [🎮 功能一览](#-功能一览)
- [📁 项目结构](#-项目结构)
- [🚀 最快 3 步跑起来](#-最快-3-步跑起来)
- [🪟 Windows 启动脚本](#-windows-启动脚本)
- [🌐 让朋友也能玩：部署到公网](#-让朋友也能玩部署到公网)
- [🏠 方案 A：云服务器（长期稳定，推荐）](#-方案-a云服务器长期稳定推荐)
- [🐳 方案 B：Docker](#-方案-bdocker)
- [🔌 方案 C：内网穿透（零公网 IP，国内可用）](#-方案-c内网穿透零公网-ip国内可用)
- [🔑 cpolar 详细配置](#-cpolar-详细配置)
- [🎯 游戏玩法](#-游戏玩法)
- [⚙️ 配置参数](#️-配置参数)
- [🔍 常见问题](#-常见问题)
- [📂 进阶部署文件](#-进阶部署文件)
- [📜 License](#-license)

---

## 🎮 功能一览

- ✅ 标准德州扑克规则（盲注、庄家轮转、翻牌前/翻牌/转牌/河牌四街道）
- ✅ **边池（side pot）** 正确分配，支持任意玩家数量 all-in；弃牌死钱与未跟注超额均正确入池/退还
- ✅ 完整牌型评估（皇家同花顺 → 高牌，7 选 5 最优组合）
- ✅ **反作弊**：只有自己能看到自己的底牌，他人底牌仅在摊牌后对未弃牌者公开
- ✅ 实时聊天、牌局日志、结算弹窗
- ✅ 自动排除输光筹码玩家，下一局继续
- ✅ 服务端全量输入校验（载荷类型、房间号、昵称、聊天长度、行动金额）
- ✅ 自动化测试：76 个用例 + 随机 1 万局不变量测试
- ✅ 手机、平板、桌面自适应布局

## 📁 项目结构

```
.
├── server.js               ← 入口：Express + Socket.IO
├── package.json            ← 依赖（express, socket.io）
├── game/
│   ├── pokerGame.js        ← 游戏状态机（盲注、下注轮、边池、结算）
│   ├── handEvaluator.js    ← 牌型评估（10 级排序、踢脚牌比较、A-2-3-4-5 顺子）
│   └── deck.js             ← 牌组、洗牌、发牌
├── test/                   ← 自动化测试（node:test，9 个文件 76 个用例）
├── test-support/           ← 测试辅助（随机对局生成器、原生 WebSocket 客户端，不参与测试发现）
├── public/
│   ├── index.html          ← 登录页 + 游戏页
│   ├── client.js           ← 前端状态渲染、Socket.IO 交互
│   └── style.css           ← 桌面 + 手机响应式样式
├── start.bat               ← Windows 本地一键启动
├── start-public.bat        ← Windows 公网一键启动（服务器 + cpolar 穿透）
├── Dockerfile / docker-compose.yml
├── ecosystem.config.js     ← PM2 守护配置
├── nginx.conf.example      ← 反向代理示例（含 WebSocket 支持）
├── DEPLOY.md               ← 完整部署参考
└── tools/                  ← 辅助工具（cpolar.exe 等，不上传）
```

## 🚀 最快 3 步跑起来

**前置：Node.js 18+（推荐 20 LTS）。** 系统没装？去 https://nodejs.org 下一个，或者下载便携版 zip 解压后直接用。

```bash
# 1. 克隆 / 下载代码
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>

# 2. 安装依赖（只需要 express 和 socket.io 两个）
npm install

# 3. 启动服务
node server.js
```

浏览器打开 <http://localhost:3000> 即可。把房间号（随便填一个相同的）分享给同局域网的朋友，就能联机。

跑测试（使用 Node 内置测试框架，无需额外安装）：

```bash
npm test              # 全部测试
npm run test:random   # 只跑随机 1 万局不变量测试
```

## 🪟 Windows 启动脚本

项目里已经内置了两个脚本，双击即可：

| 脚本 | 作用 | 使用场景 |
|------|------|---------|
| `start.bat` | 本地启动（默认用系统 Node，找不到时回退到便携版路径） | 本机或局域网测试 |
| `start-public.bat` | 启动服务 + cpolar 内网穿透 | 想让公网朋友也能进 |

`start.bat` 默认会去找 `C:\Users\Ray\AppData\Local\Temp\node-v20.18.1-win-x64\node.exe`。如果你自己的 Node 路径不同，打开脚本改第一行的 `set "NODE=..."` 即可。

## 🌐 让朋友也能玩：部署到公网

本项目监听 `0.0.0.0:3000`，只要服务器本身有公网 IP 且防火墙放行 3000 端口，浏览器就能直接访问。下面按「由快到稳」推荐 3 种方式：

| 方案 | 适合 | 准备 |
|------|------|------|
| **C. 内网穿透（cpolar）** | 临时玩、没有公网 IP | cpolar 账号 + authtoken |
| **B. Docker** | 已有 Docker 的服务器 | 云服务器 + Docker |
| **A. 云服务器直接跑** | 长期稳定、HTTPS | 任意云厂商（阿里云/腾讯云/华为云等） |

## 🏠 方案 A：云服务器（长期稳定，推荐）

1. 买一台最便宜的云服务器（腾讯云轻量 / 阿里云 ECS / 华为云 ECS 都行），系统选 Ubuntu 22.04 或 CentOS Stream 9。最低配 1 核 2G 足够。
2. 在云控制台的**安全组 / 防火墙**里放行 `3000/tcp`（或者最后用 Nginx 反代到 80/443）。
3. SSH 上去：

```bash
# 安装 Node.js 20（Ubuntu/Debian 用这个）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 拉代码 & 启动
git clone https://github.com/<你的用户名>/<仓库名>.git poker
cd poker && npm install
node server.js
# 出现 "德州扑克服务器运行在 http://localhost:3000" 就 OK
```

4. 浏览器访问 `http://<你的云服务器公网IP>:3000`，能打开登录页就是部署成功了。
5. **建议改用 PM2 守护**，避免 SSH 断开导致服务退出：

```bash
sudo npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 按提示复制一行命令，让 PM2 开机自启
```

**（可选）Nginx 反代 + HTTPS**：把 `nginx.conf.example` 里的配置贴到 `/etc/nginx/sites-available/poker`，`proxy_pass http://127.0.0.1:3000;`，`proxy_set_header Upgrade` 和 `Connection upgrade` 两行**必须保留**（Socket.IO 需要）。域名 DNS 指到服务器后，用 `sudo certbot --nginx -d 你的域名` 一键签 HTTPS 证书。

## 🐳 方案 B：Docker

```bash
docker build -t poker .
docker run -d --name poker -p 3000:3000 --restart unless-stopped poker
```

或直接：

```bash
docker compose up -d
```

## 🔌 方案 C：内网穿透（零公网 IP，国内可用）

如果你没有云服务器、家里宽带又被运营商做了 **CGNAT（大内网）**，最简单的办法就是让一台**国内**穿透工具把 `localhost:3000` 暴露出去。

本项目推荐 **cpolar**（国内服务，免费版就能用，域名是 `*.vip.cpolar.cn`，国内直连不卡）。其他同类工具如 **natapp**、**花生壳** 原理相同，参考配置即可。

### 🔑 cpolar 详细配置

#### 第一步：注册 & 获取 authtoken

1. 打开 <https://dashboard.cpolar.com/signup> 注册一个账号（邮箱即可）。
2. 登录后访问 <https://dashboard.cpolar.com/auth>，复制页面上那串 **Authtoken**（形如 `OWQ0MjQ5Yjgt...`，这是你唯一需要保管的凭证）。

#### 第二步：安装 cpolar

**Windows**：去 <https://www.cpolar.com/download> 下载 Windows 安装包（或 zip 版），解压后得到 `cpolar.exe`。项目自带的 `start-public.bat` 会自动用 `tools\cpolar.exe` 这个路径。

**macOS / Linux**：官方一键安装脚本：

```bash
curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash
```

#### 第三步：第一次启动

```bash
# 1. 先把 authtoken 写入配置（一次性）
cpolar authtoken 你的Authtoken字符串

# 2. 启动德州扑克服务（另一个终端或后台）
node server.js

# 3. 启动穿透隧道
cpolar http 3000 -region=cn_vip
```

> ⚠️ **`-region=cn_vip` 必须带！** 不加的话默认会分到美国区，域名是 `*.cpolar.top`，国内 DNS 经常解析不到。

#### 第四步：拿到公网地址

cpolar 启动后会输出类似：

```
Tunnel established at https://2c31ded7.r19.vip.cpolar.cn
```

把这个 **https 地址** 发给朋友，他们在浏览器打开就能进你的牌桌。

#### 一键启动脚本（Windows）

项目里的 `start-public.bat` 已经把上面三步串在一起：第一次运行会让你粘贴 authtoken 自动保存，之后双击即可。脚本会：

1. 找到 Node.js（系统 PATH 或便携版路径）
2. 后台启动扑克服务器
3. 前台启动 cpolar 并打印公网地址

#### cpolar 免费版的局限

| 特性 | 免费版 | 付费版（个人版 ≈ ¥9/月） |
|------|--------|------------------------|
| 域名 | 每次重启都会变 | 固定二级域名 |
| 带宽 | ~1-3 Mbps | 更高 |
| 稳定性 | 偶尔掉线 | 服务守护 |
| 多隧道 | 1 条 | 多条 |

#### 做成后台守护

**Windows**（避免关掉命令行窗口就断线）：

```powershell
cpolar service install   # 安装为服务
cpolar service start     # 开机自启
```

**Linux**：安装后默认自带 systemd 服务：

```bash
sudo systemctl start cpolar
sudo systemctl enable cpolar
```

## 🎯 游戏玩法

- 进房间后，大家都点 **开始游戏**（其实任意一人点了就会开始）。
- 小盲（SB）和大盲（BB）自动下。庄家位（D）每局顺时针轮转。
- 四街道：翻牌前 → 翻牌（3 张）→ 转牌（1 张）→ 河牌（1 张）→ 摊牌。
- 操作按钮：**弃牌 / 过牌 / 跟注 / 加注（滑杆）/ 全押**。
- 一局结束会弹出结算弹窗，点 **开始下一局** 继续。
- 没筹码的玩家自动坐出本局，不影响其他人继续玩。

## ⚙️ 配置参数

在 `server.js` 里以环境变量传入：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 监听端口 |
| `NODE_ENV` | - | 设为 `production` 可减少某些调试输出 |

在 `game/pokerGame.js` 构造函数里可改：

```js
new PokerGame(roomId, {
  smallBlind: 10,     // 小盲注
  bigBlind: 20,       // 大盲注
  startingChips: 1000 // 初始筹码
})
```

## 🔍 常见问题

**Q: 我自己能打开，但朋友打不开？**
A: 本地用的是 `localhost`，朋友访问不到。要么放行路由器/云防火墙端口 3000，要么用内网穿透（见方案 C）。

**Q: cpolar 域名 `*.cpolar.top` 打不开？**
A: 启动时加 `-region=cn_vip`，这样拿到的是 `*.vip.cpolar.cn`，国内 DNS 才能解析。

**Q: 进房间后点"开始游戏"没反应？**
A: 至少要有 2 名玩家都在线、且每人还有筹码。筹码输光的玩家这一局不能继续。

**Q: 手机上中间的牌被遮住了？**
A: 已经修复。刷新或清缓存（Ctrl+Shift+R / Cmd+Shift+R）后即可。

**Q: 服务器 CPU 占用高？**
A: 2-7 人的牌桌 Socket.IO 开销可以忽略，检查一下是不是其他进程。

**Q: 想让朋友随时都能进？**
A: 云服务器 + PM2 + Nginx + HTTPS（方案 A）是唯一长期稳定的方案。

## 📂 进阶部署文件

仓库内另外几个文件供快速上手参考，完整步骤请看同目录下的 **`DEPLOY.md`**：

| 文件 | 用途 |
|------|------|
| `Dockerfile` | 基于 `node:20-alpine` 的生产镜像 |
| `docker-compose.yml` | 一行 `docker compose up -d` 跑起来 |
| `ecosystem.config.js` | PM2 配置，带 `max_memory_restart: 500M` |
| `nginx.conf.example` | Nginx 反代模板，已包含 WebSocket Upgrade 和长连接超时 |
| `.dockerignore` | Docker build 时排除无关文件 |

## 📜 License

MIT — 随便玩、随便改、随便部署。玩得开心就行 ♠♥♦♣
