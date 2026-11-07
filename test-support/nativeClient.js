// 原生 WebSocket 客户端：直接说 socket.io 的 Engine.IO 线协议，
// 用于测试，不依赖 socket.io-client。
//
// 协议要点（EIO=4）：
//   服务端 → "0{...}"   open
//   客户端 → "40"       连接默认命名空间
//   服务端 → "40{sid}"  连接确认
//   事件   → '42' + JSON 数组
//   服务端 → "2" ping，客户端必须回 "3" pong
//   关闭   → "1"

class NativeSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs || 5000;
    this.handlers = new Map(); // event -> Set<fn>
    this.queue = []; // 已到达但尚无监听器的事件
    this.connected = false;
    this.closed = false;
    this._pongTimer = null;

    const wsUrl = url.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    this.ws = new WebSocket(wsUrl);
    this._openPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), this.timeoutMs);
      this.ws.onopen = () => {
        // 等待 40 确认后才算连上
        this._onNamespaceReady = () => {
          clearTimeout(timer);
          this.connected = true;
          resolve();
        };
        this.ws.send('40');
      };
      this.ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('连接失败: ' + (e && e.message ? e.message : 'unknown')));
      };
    });

    this.ws.onmessage = (evt) => this._onMessage(String(evt.data));
    this.ws.onclose = () => {
      this.connected = false;
      this.closed = true;
      this._flush('disconnect', 'transport close');
    };
  }

  _onMessage(data) {
    // ping → pong
    if (data === '2') {
      this.ws.send('3');
      return;
    }
    if (data.startsWith('0')) {
      // open packet
      const info = safeParse(data.slice(1));
      this.pingInterval = info && info.pingInterval;
      return;
    }
    if (data.startsWith('40')) {
      if (this._onNamespaceReady) {
        this._onNamespaceReady();
        this._onNamespaceReady = null;
      }
      return;
    }
    if (data.startsWith('42')) {
      const payload = safeParse(data.slice(2));
      if (!Array.isArray(payload) || payload.length === 0) return;
      const [event, ...args] = payload;
      this._flush(event, args.length > 1 ? args : args[0]);
      return;
    }
    if (data.startsWith('44')) {
      this._flush('connect_error', safeParse(data.slice(2)));
      return;
    }
    if (data === '1') {
      this.closed = true;
      this._flush('disconnect', 'server close');
    }
  }

  _flush(event, payload) {
    const set = this.handlers.get(event);
    if (set && set.size > 0) {
      for (const fn of [...set]) fn(payload);
      return;
    }
    this.queue.push({ event, payload });
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this.handlers.get(event);
    if (set) set.delete(fn);
    return this;
  }

  once(event, timeoutMs = this.timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off(event, handler);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const handler = (payload) => finish(payload);
      this.on(event, handler);

      // 已经排队的事件立即消费（避免事件早于监听器到达时丢消息）
      const idx = this.queue.findIndex(q => q.event === event);
      if (idx >= 0) {
        const [item] = this.queue.splice(idx, 1);
        finish(item.payload);
      }
    });
  }

  emit(event, payload) {
    if (this.ws.readyState !== 1) return false;
    const frame = payload === undefined ? [event] : [event, payload];
    this.ws.send('42' + JSON.stringify(frame));
    return true;
  }

  // 丢弃已排队但尚未消费的事件（用于“只看后续状态”的场景）
  drainQueue(event) {
    if (!event) {
      this.queue.length = 0;
      return;
    }
    this.queue = this.queue.filter(q => q.event !== event);
  }

  // 等待第一个满足 predicate 的 state（优先消费队列中已到达的，再看新事件）
  waitForState(predicate = () => true, timeoutMs = this.timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('state', handler);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const handler = (state) => {
        try {
          if (predicate(state)) finish(state);
        } catch (_) { /* predicate 抛错则忽略 */ }
      };

      // 先看已排队的事件
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.event !== 'state') continue;
        try {
          if (predicate(q.payload)) {
            this.queue.splice(i, 1);
            finish(q.payload);
            return;
          }
        } catch (_) { /* ignore */ }
      }

      this.on('state', handler);
    });
  }

  async connect() {
    await this._openPromise;
    return this;
  }

  disconnect() {
    if (this.ws.readyState === 1 || this.ws.readyState === 0) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
    }
    this.connected = false;
    this.closed = true;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// 便捷工厂：连接并等待就绪
async function connectNative(url, options) {
  const socket = new NativeSocket(url, options);
  await socket.connect();
  return socket;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { NativeSocket, connectNative, sleep };
