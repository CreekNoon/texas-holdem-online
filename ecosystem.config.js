// PM2 进程管理配置
// 安装 PM2: npm install -g pm2
// 启动: pm2 start ecosystem.config.js
// 查看状态: pm2 list
// 查看日志: pm2 logs poker
// 停止: pm2 stop poker
// 开机自启: pm2 startup && pm2 save

module.exports = {
  apps: [
    {
      name: 'poker',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
