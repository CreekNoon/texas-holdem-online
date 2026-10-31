# 使用 Node.js 20 LTS 官方镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖清单并安装生产依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制项目源码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["node", "server.js"]
