// PRD-04：音效（WebAudio 合成，无外部文件）
//
// 约束：
// - 浏览器要求用户手势后才能播放音频，因此在首次交互时 unlock
// - 音效开关持久化到 localStorage

const Sound = (() => {
  let ctx = null;
  let enabled = true;
  let unlocked = false;

  const KEY = 'poker:sound';

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw !== null) enabled = raw === '1';
    } catch (_) { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(KEY, enabled ? '1' : '0');
    } catch (_) { /* ignore */ }
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  // 首次用户手势时解锁
  function unlock() {
    if (unlocked) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    unlocked = true;
  }

  function tone({ freq = 440, dur = 0.08, type = 'sine', gain = 0.08, delay = 0 }) {
    if (!enabled || !unlocked) return;
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  return {
    load,
    unlock,
    isEnabled: () => enabled,
    setEnabled(v) {
      enabled = !!v;
      save();
    },
    deal() {
      tone({ freq: 720, dur: 0.05, type: 'triangle', gain: 0.05 });
    },
    chip() {
      tone({ freq: 520, dur: 0.06, type: 'square', gain: 0.04 });
      tone({ freq: 780, dur: 0.05, type: 'square', gain: 0.03, delay: 0.03 });
    },
    flip() {
      tone({ freq: 380, dur: 0.07, type: 'sine', gain: 0.05 });
    },
    win() {
      tone({ freq: 523, dur: 0.12, type: 'sine', gain: 0.07 });
      tone({ freq: 659, dur: 0.12, type: 'sine', gain: 0.07, delay: 0.1 });
      tone({ freq: 784, dur: 0.18, type: 'sine', gain: 0.07, delay: 0.2 });
    },
    lose() {
      tone({ freq: 300, dur: 0.16, type: 'sine', gain: 0.05 });
      tone({ freq: 220, dur: 0.2, type: 'sine', gain: 0.05, delay: 0.12 });
    }
  };
})();

Sound.load();
