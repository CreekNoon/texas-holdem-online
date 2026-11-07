// 起真实 server 的测试辅助（原生 WebSocket，不依赖 socket.io-client）
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { connectNative, sleep } = require('./nativeClient');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await findFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('德州扑克服务器运行在')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 code=${code} stderr=${stderr}`));
    });
  });

  return {
    port,
    child,
    url: `http://127.0.0.1:${port}`,
    stderr: () => stderr,
    stop: () => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
  };
}

async function joinRoom(port, roomId, name, extra = {}) {
  const socket = await connectNative(`http://127.0.0.1:${port}`);
  socket.emit('join', { roomId, name, ...extra });
  const joined = await socket.once('joined');
  return { socket, joined };
}

module.exports = { findFreePort, startServer, joinRoom, sleep, connectNative };
