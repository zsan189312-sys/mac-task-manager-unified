// 任务管理器-统一版 渲染进程：同一套 UI 承载「本机 Mac」与「远程 Linux 主机」
const HIST = 60;
let histIntervalMs = 2000;    // 当前主机的采样间隔，用于横轴时间窗标注（窗口 = HIST × 间隔）
const SERIES_KEYS = ['cpu', 'mem', 'disk', 'netrx', 'nettx', 'power', 'temp', 'gpu', 'batt'];
function newHist() { return { cpu: [], mem: [], disk: [], netrx: [], nettx: [], power: [], temp: [], gpu: [], batt: [], cores: [] }; }
let hist = newHist();
// 按主机保留历史曲线：切换主机时保存当前缓冲、切回时恢复，避免重新采样从零开始
const histCache = {}; // hostId -> hist
let histHostId = null; // 曲线缓冲当前归属的主机：点切换即绑定，不等首帧数据
let switchAt = 0;      // 最近一次切换主机的时刻，用于识别切换瞬间在途的旧主机数据帧
// 离开某台主机时在其各条曲线上打一个断点（null）：切回后线条在断档处断开，
// 而不是把「离开期间的空白」压缩成一条连续的假线
function markGap(h) {
  SERIES_KEYS.forEach(k => { if (Array.isArray(h[k]) && h[k].length) h[k].push(null); });
  (h.cores || []).forEach(a => { if (Array.isArray(a) && a.length) a.push(null); });
}
// 幂等：重复调用同一个目标主机不会重复打断点、更不会把缓存覆盖成空缓冲
function switchHist(toId) {
  if (!toId || histHostId === toId) return;
  if (histHostId) {
    // 本机由后台常驻采样持续喂曲线（切走也不停采），不算断档；
    // 远程主机不看时确实没采样，才打断点避免把空白画成假线
    const prev = hostList.find(h => h.id === histHostId);
    if (prev && prev.kind !== 'local') markGap(hist);
    histCache[histHostId] = hist;
  }
  hist = histCache[toId] || newHist();
  histCache[toId] = hist;
  histHostId = toId;
  // 兜底同步横轴时间窗：本机固定 2 秒（自动切换路径如「删除当前主机」不走点击处理）
  const t = hostList.find(h => h.id === toId);
  if (t && t.kind === 'local') histIntervalMs = 2000;
}

const CARD_DEFS = {
  cpu: { title: 'CPU', color: '#0a84ff' },
  mem: { title: '内存', color: '#bf5af2' },
  disk: { title: '磁盘', color: '#30d158' },
  net: { title: '网络', color: '#ffd60a' },
  gpu: { title: 'GPU', color: '#64d2ff' },
  batt: { title: '电池', color: '#ff9f0a' },
  power: { title: '功耗 / 温度', color: '#ff9f0a' }
};
let activeCard = 'cpu';
let latest = null;
let battEstBuf = [];     // 电池估算最近的有效样本（小时），取中位数抗毛刺
let battEstAt = 0;       // 上次推入样本的时间戳，按时间间隔去重（电池每 6s 刷新，渲染每 2s）
let battEstState = null; // 上次估算时的电池状态（放电/充电/接通），切换时清空缓冲
let procSort = 'cpu';
let procQuery = '';
let bodyBuilt = false;
let currentHostId = null;
let hostList = [];

// ---------- 工具 ----------
function fmtSize(b) {
  if (b === null || b === undefined || isNaN(b)) return '—';
  if (b >= 100 * 1024 ** 3) return (b / 1024 ** 3).toFixed(0) + ' GB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b.toFixed(0) + ' B';
}
function fmtRate(bps) {
  if (bps === null || bps === undefined || isNaN(bps)) return '—';
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps.toFixed(0) + ' B/s';
}
function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function setText(id, v) { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; }
function setHTML(id, v) { const el = document.getElementById(id); if (el && el.innerHTML !== v) el.innerHTML = v; }  // 仅用于自产字符串，勿传外部数据

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// 序列里的 null/NaN 表示「此处无数据」（主机切换留下的空档）：只断开笔画，不连线
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function seriesMax(yMax, ...arrs) {
  let m = isNum(yMax) ? yMax : 0;
  arrs.forEach(a => (a || []).forEach(v => { if (isNum(v) && v > m) m = v; }));
  return Math.max(m, 0.0001) * 1.15;
}
function strokeSeries(ctx, data, x0, step, h, max, color, fill) {
  let seg = [];
  const flush = () => {
    if (seg.length >= 2) {
      ctx.beginPath();
      seg.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
      if (fill) {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
        ctx.lineTo(seg[seg.length - 1][0], h); ctx.lineTo(seg[0][0], h); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      }
    }
    seg = [];
  };
  data.forEach((v, i) => {
    if (!isNum(v)) { flush(); return; }
    seg.push([x0 + i * step, h - 1.5 - (v / max) * (h - 3)]);
  });
  flush();
}

function drawSeries(cv, data, color, yMax) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const valid = data.filter(isNum);
  if (valid.length < 2) return;
  const step = w / (HIST - 1);
  const x0 = w - (data.length - 1) * step;
  strokeSeries(ctx, data, x0, step, h, seriesMax(yMax, valid), color, true);
}

// 双向曲线：零基线居中、正负对称缩放。用于电池充放电功率（充入为正 / 放出为负）。
function drawBipolar(cv, data, color) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const valid = data.filter(isNum);
  if (valid.length < 2) return;
  const maxAbs = Math.max(1, ...valid.map(v => Math.abs(v))) * 1.15;
  const mid = h / 2;
  // 零基线
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke();
  const step = w / (HIST - 1);
  const x0 = w - (data.length - 1) * step;
  let seg = [];
  const flush = () => {
    if (seg.length >= 2) {
      ctx.beginPath();
      seg.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
      // 向零基线淡填充，强调充电/放电方向
      ctx.lineTo(seg[seg.length - 1][0], mid); ctx.lineTo(seg[0][0], mid); ctx.closePath();
      ctx.fillStyle = color + '14'; ctx.fill();
    }
    seg = [];
  };
  data.forEach((v, i) => {
    if (!isNum(v)) { flush(); return; }
    seg.push([x0 + i * step, mid - (v / maxAbs) * (mid - 2)]);
  });
  flush();
}

// 电池功率颜色：充入橙、放出蓝
function battPowerColor(d) {
  const wv = d && d.batt ? d.batt.watts : null;
  return (typeof wv === 'number' && wv > 0) ? '#ff9f0a' : '#0a84ff';
}

function drawOverlaid(cv, primary, secondary, c1, c2) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const max = seriesMax(0, primary, secondary), step = w / (HIST - 1);
  for (const [data, color, fill] of [[primary, c1, true], [secondary, c2, false]]) {
    if (!data || data.filter(isNum).length < 2) continue;
    strokeSeries(ctx, data, w - (data.length - 1) * step, step, h, max, color, fill);
  }
}

// 横轴时间窗标注：窗口 = HIST × 当前采样间隔（本机 2s → 2 分钟；远程 5s → 5 分钟）
function updateAxisLabels() {
  const sec = Math.round(histIntervalMs * HIST / 1000);
  const txt = sec >= 60 ? (sec / 60).toFixed(sec % 60 === 0 ? 0 : 1) + ' 分钟前' : sec + ' 秒前';
  setText('chart-x-left', txt);
  setText('disk-peak-label', sec >= 60 ? (sec / 60).toFixed(sec % 60 === 0 ? 0 : 1) + ' 分钟峰值' : sec + ' 秒峰值');
}

// ---------- 主机切换 ----------
async function renderHostSeg() {
  const r = await window.bridge.getHosts();
  hostList = r.hosts || [];
  const seg = document.getElementById('host-seg');
  seg.innerHTML = '';
  hostList.forEach(h => {
    const el = document.createElement('div');
    el.className = 'host-chip' + (h.id === r.active ? ' active' : '');
    el.innerHTML = `<span class="hdot ${h.kind}"></span>${esc(h.name)}` +
      (h.kind === 'remote' ? '<span class="hx" title="移除">×</span>' : '');
    el.onclick = async (ev) => {
      try {
        if (ev.target.classList.contains('hx')) {          // 删除主机
          const cur0 = await window.bridge.getHosts();      // 以主进程真实状态判断，避免闭包快照过期
          const wasActive = h.id === cur0.active;
          await window.bridge.removeHost(h.id);
          delete histCache[h.id];
          if (wasActive) {                                  // 删掉的正是当前主机：立刻改绑新的 active
            switchAt = Date.now();
            const r2 = await window.bridge.getHosts();
            histHostId = null;
            switchHist(r2.active);
            resetForHostSwitch();
            const nh = (r2.hosts || []).find(x => x.id === r2.active);
            setText('sb-left', `已删除主机，切换到 ${(nh && nh.name) || r2.active}…`);
          }
          return;
        }
        // 以主进程的真实激活状态为准判断「是不是已经在看这台」：
        // 之前用渲染时的闭包快照 r.active，一旦它与实际不一致（自动切换、外部切换过主机），
        // 点这台主机就会被判成「已激活」而静默失效，完全点不动
        const cur = await window.bridge.getHosts();
        if (h.id === cur.active) { renderHostSeg(); return; }
        await applyHostSwitch(h.id, h, cur.intervalMs);
      } catch (err) {
        console.error('host switch error', err);
      } finally {
        renderHostSeg();   // 无论成败都刷新，避免 chips 停在旧 active 上导致后续点击被判为「已激活」而失效
      }
    };
    seg.appendChild(el);
  });
  const add = document.createElement('button');
  add.id = 'host-add'; add.textContent = '+'; add.title = '添加远程主机';
  add.onclick = () => document.getElementById('host-form').classList.add('on');
  seg.appendChild(add);

  // 轮询档位：仅对远程主机生效（本机固定 2 秒）
  document.querySelectorAll('#poll-ctl button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.ms, 10) === r.intervalMs));
}

function resetForHostSwitch() {
  latest = null; bodyBuilt = false; builtKey = '';
  resetFilesForHostSwitch();
  document.getElementById('connection-hint').style.display = 'none';
  document.getElementById('detail-body').innerHTML = '';
  document.getElementById('proc-tbody').innerHTML = '';
  setText('detail-meta', '正在采集新主机…');
  setText('osinfo', '正在切换主机…');
  const cv = document.getElementById('bigchart');
  if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  // 保留用户当前查看的卡片（新主机没有该卡片时由 buildSidebarFor/onStats 回落到 CPU）
  // 历史曲线不清空：由 onStats 的 hostChanged 分支 switchHist() 按主机缓存/恢复
  buildSidebarFor(null, true);
}

// 统一切换入口（主机 chip 点击 / 启动直达都用它）：
// 主进程切 → 曲线缓冲立刻改绑目标主机 → 横轴刻度 → 状态栏提示
async function applyHostSwitch(id, host, intervalMs) {
  if (!(await window.bridge.setHost(id))) return false;
  switchAt = Date.now();
  resetForHostSwitch();
  switchHist(id);   // 不等首帧：立刻恢复该主机缓存的曲线
  histIntervalMs = (host && host.kind === 'local') ? 2000 : (intervalMs || histIntervalMs);
  updateAxisLabels();
  setText('sb-left', `正在切换到 ${(host && host.name) || id}…`);
  return true;
}

document.getElementById('hf-cancel').onclick = () => document.getElementById('host-form').classList.remove('on');
document.getElementById('hf-ok').onclick = async () => {
  const name = document.getElementById('hf-name').value.trim();
  const host = document.getElementById('hf-host').value.trim();
  const port = parseInt(document.getElementById('hf-port').value.trim(), 10) || 9100;
  if (!name || !host) return;
  const r = await window.bridge.addHost({ name, host, port });
  document.getElementById('host-form').classList.remove('on');
  document.getElementById('hf-name').value = '';
  document.getElementById('hf-host').value = '';
  document.getElementById('hf-port').value = '';
  if (r && r.ok) renderHostSeg();
};

// ---------- 侧栏 ----------
// 最近一次已知的卡片集合：切换主机的空档期（上一台已停、新主机首帧还没到）沿用上一次的集合，
// 避免 GPU/电池/功耗卡片闪一下不见，也避免此时点卡片把选择重置成 CPU
let lastCardIds = ['cpu', 'mem', 'disk', 'net'];
let sidebarSig = '';
let sidebarPowerTitle = '';   // 侧栏当前渲染的功耗卡片标题（切主机时若变化需重建）
function cardsFor(d) {
  if (!d) return lastCardIds.slice();
  const ids = ['cpu'];
  if (d.gpu) ids.push('gpu');   // GPU 紧跟 CPU（本机核显 / 远程 N100 核显）
  ids.push('mem', 'disk', 'net');
  if (d.batt) ids.push('batt');
  if (d.power) ids.push('power');
  return ids;
}
function buildSidebarFor(d, keepCard) {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const ids = d ? cardsFor(d) : lastCardIds.slice();
  if (d) { lastCardIds = ids.slice(); sidebarSig = ids.join(','); sidebarPowerTitle = cardTitle('power', d); }
  if (!keepCard && !ids.includes(activeCard)) activeCard = 'cpu';
  ids.forEach(id => {
    const c = CARD_DEFS[id];
    const el = document.createElement('div');
    el.className = 'card' + (id === activeCard ? ' active' : '');
    el.dataset.id = id;
    el.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <div class="card-body">
        <div class="card-title">${id === 'power' ? cardTitle(id, d) : c.title}</div>
        <div class="card-sub" id="sub-${id}">正在采样…</div>
      </div>
      <canvas id="spark-${id}"></canvas>`;
    el.onclick = () => { activeCard = id; bodyBuilt = false; buildSidebarFor(latest); tickDetail(true); };
    sb.appendChild(el);
  });
  if (d) updateSidebar(d);
}
function buildSidebar() { buildSidebarFor(latest); }

function mainIface(d) {
  const list = (d.net && d.net.ifaces) || [];
  const pref = d.host.kind === 'local' ? ['en0', 'en1']
    : d.host.kind === 'win' ? ['以太网', 'Ethernet', '以太网 2', 'WLAN', 'Wi-Fi', 'Tailscale']
    : ['wlo1', 'wlan0', 'eth0', 'enp1s0', 'tailscale0'];
  for (const n of pref) { const f = list.find(i => i.name === n); if (f) return f; }
  return list.slice().sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx))[0] || null;
}
function pkgTemp(d) {
  if (d.power && d.power.style === 'win') {
    const value = d.power.cpuTemp;
    return Number.isFinite(value) && value > 0 ? value.toFixed(1) : '—';
  }
  const t = (d.power && d.power.temp) || {};
  return t['x86_pkg_temp'] !== undefined ? t['x86_pkg_temp'].toFixed(0)
    : Object.values(t)[0] !== undefined ? Object.values(t)[0].toFixed(0) : '—';
}

function updateSidebar(d) {
  setText('sub-cpu', `${d.cpu.total.toFixed(0)}% · ${d.cpu.count} 核`);
  setText('sub-mem', `${fmtSize(d.mem.used)} / ${fmtSize(d.mem.total)}`);
  setText('sub-disk', fmtRate(d.disk.totalR + d.disk.totalW));
  const m = mainIface(d);
  setText('sub-net', m ? `${m.name} ↓${fmtRate(m.rx)}` : '无接口');
  if (d.gpu) {
    const g = d.gpu;
    const u = (g.util === null || g.util === undefined) ? '—' : g.util.toFixed(0) + '%';
    setText('sub-gpu', g.style === 'linux'
      ? `${u} · ${g.freq > 0 ? g.freq + ' MHz' : '空闲'}`
      : g.style === 'win'
        ? `${u}${g.power !== null && g.power !== undefined ? ' · ' + g.power.toFixed(0) + ' W' : ''}`
        : `${u} · ${fmtSize(g.memBytes)}`);
  }
  if (d.batt) setText('sub-batt', `${d.batt.percent}%${d.batt.status === 'charging' ? ' · 充电中' : d.batt.status === 'discharging' ? ' · 放电中' : ''}`);
  // v1.2.7：N100 / Win 11 侧栏小字只留功耗数据（温度看详情页），MacBook 保留 CPU 封装温度
  if (d.power) {
    const remote = d.host.kind === 'remote' || d.host.kind === 'win';
    setText('sub-power', d.power.ok
      ? (remote ? `${d.power.pkg.toFixed(1)} W` : `${d.power.pkg.toFixed(1)} W · ${pkgTemp(d)}℃`)
      : (remote ? '功耗不可用' : `${pkgTemp(d)}℃ · 功耗不可用`));
  }

  drawSeries(document.getElementById('spark-cpu'), hist.cpu, '#0a84ff');
  drawSeries(document.getElementById('spark-mem'), hist.mem, '#bf5af2', 100);
  drawSeries(document.getElementById('spark-disk'), hist.disk, '#30d158');
  // 接收与发送必须叠加绘制：drawSeries 会先 clearRect，连续调两次只会剩下发送曲线
  drawOverlaid(document.getElementById('spark-net'), hist.netrx, hist.nettx, '#ffd60a', '#ff453a');
  if (d.gpu) drawSeries(document.getElementById('spark-gpu'), hist.gpu, '#64d2ff', 100);
  if (d.batt) drawBipolar(document.getElementById('spark-batt'), hist.batt, battPowerColor(d));
  if (d.power) drawSeries(document.getElementById('spark-power'), hist.power, '#ff9f0a');
}

// ---------- 详情 ----------
const titleMap = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网络', gpu: 'GPU', batt: '电池', power: '功耗 / 温度' };
// v1.2.6：N100 / Win 11 的功耗卡片标题简化为「功耗」，MacBook 本机保持「功耗 / 温度」
// d 参数：buildSidebarFor 切主机重建时传入新主机 payload，避免读到旧的 latest
function cardTitle(id, d) {
  const k = ((d || latest) && (d || latest).host || {}).kind;
  if (id === 'power' && (k === 'remote' || k === 'win')) return '功耗';
  return titleMap[id];
}

const detailDefs = {
  cpu: {
    build(d) {
      const types = d.cpu.coreTypes || [];
      const hasPE = types.includes('P') || types.includes('E');
      // Windows 超线程 CPU：12 逻辑核 = 6 物理核 + 超线程，6 列正好两行（Windows 枚举 0–5 为物理核）
      const c6 = d.host.kind === 'win' && d.cpu.cores.length === 12;
      const title = hasPE ? '逻辑核心（P = 性能核 / E = 能效核）'
        : c6 ? '逻辑核心（上行 0–5 = 物理核 / 下行 6–11 = 超线程）'
        : '逻辑核心（真实频率，非估算）';
      let html = `
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">${hasPE ? '全部核心' : '全部核心'}（${d.cpu.count} 核）</span>
            <span class="panel-value" style="color:var(--p-core)" id="cpu-val">—</span>
          </div>
          <canvas id="cpu-curve"></canvas>
        </div>
        <div class="section-title">${title}</div><div class="tiles${d.cpu.cores.length === 4 ? ' c4' : c6 ? ' c6' : ''}">`;
      d.cpu.cores.forEach((v, i) => {
        const nm = hasPE ? (types[i] || '?') + (types[i] === 'P' ? types.slice(0, i + 1).filter(x => x === 'P').length - 1
          : types.slice(0, i + 1).filter(x => x === 'E').length - 1) : i;
        html += `
          <div class="tile">
            <div class="tile-head">
              <span class="tile-name"><b>${hasPE ? esc(String(nm)) : 'CPU ' + i}</b></span>
              <span class="tile-val" id="tile-val-${i}">—</span>
            </div>
            <canvas id="tile-cv-${i}"></canvas>
            <div class="tile-name" style="margin-top:2px" id="tile-freq-${i}">—</div>
          </div>`;
      });
      html += `</div>
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">总利用率</div><div class="info-value" id="cpu-total">—</div></div>
          <div class="info-item"><div class="info-label">用户 / 系统</div><div class="info-value" id="cpu-us">—</div></div>
          <div class="info-item"><div class="info-label">${d.host.kind === 'local' || d.host.kind === 'win' ? '空闲' : 'I/O 等待'}</div><div class="info-value" id="cpu-io">—</div></div>
          <div class="info-item"><div class="info-label">当前频率</div><div class="info-value" style="font-size:13px" id="cpu-freq">—</div></div>
          <div class="info-item"><div class="info-label">${d.host.kind === 'win' ? '进程数' : '负载均值 (1/5/15 分钟)'}</div><div class="info-value" id="cpu-load">—</div></div>
          <div class="info-item"><div class="info-label">型号</div><div class="info-value" style="font-size:12.5px">${esc(d.cpu.model)}</div></div>
        </div>`;
      return html;
    },
    update(d) {
      setText('cpu-val', d.cpu.total.toFixed(0) + '%');
      drawSeries(document.getElementById('cpu-curve'), hist.cpu, '#0a84ff', 100);
      const types = d.cpu.coreTypes || [];
      d.cpu.cores.forEach((v, i) => {
        setText('tile-val-' + i, v.toFixed(0) + '%');
        const f = d.cpu.freq && d.cpu.freq[i];
        setText('tile-freq-' + i, f ? (f / 1000).toFixed(2) + ' GHz' : '—');
        const color = types[i] === 'E' ? '#30d158' : '#0a84ff';
        drawSeries(document.getElementById('tile-cv-' + i), hist.cores[i], color, 100);
      });
      setText('cpu-total', d.cpu.total.toFixed(1) + '%');
      setText('cpu-us', `${d.cpu.user.toFixed(1)}% / ${d.cpu.sys.toFixed(1)}%`);
      setText('cpu-io', (d.host.kind === 'local' || d.host.kind === 'win')
        ? (d.cpu.idle || 0).toFixed(1) + '%' : d.cpu.iowait.toFixed(1) + '%');
      if (d.host.kind === 'local') {
        const fp = d.cpu.freqP !== null && d.cpu.freqP !== undefined
          ? (700 + (d.cpu.freqP / 100) * (4410 - 700)) / 1000 : null;
        const fe = d.cpu.freqE !== null && d.cpu.freqE !== undefined
          ? (600 + (d.cpu.freqE / 100) * (2600 - 600)) / 1000 : null;
        setHTML('cpu-freq', (fp && fe) ? `P ${fp.toFixed(2)} / E ${fe.toFixed(2)} GHz <small>（估算）</small>` : '—');
      } else {
        const avgF = d.cpu.freq.length ? d.cpu.freq.reduce((a, b) => a + b, 0) / d.cpu.freq.length / 1000 : 0;
        setHTML('cpu-freq', avgF ? avgF.toFixed(2) + ' GHz <small>最大 ' + (d.cpu.freqMax / 1000).toFixed(2) + ' GHz</small>' : '—');
      }
      if (d.host.kind === 'win') {
        setText('cpu-load', d.procs.count + ' 个');   // v1.2.8：Windows 无 loadavg，该格显示进程数
      } else {
        const la = d.cpu.load;
        setText('cpu-load', la ? `${(la[0] || 0).toFixed(2)} / ${(la[1] || 0).toFixed(2)} / ${(la[2] || 0).toFixed(2)}` : '—');
      }
    },
    meta(d) {
      const types = d.cpu.coreTypes || [];
      const p = types.filter(x => x === 'P').length, e = types.filter(x => x === 'E').length;
      return d.host.kind === 'local'
        ? `${d.cpu.model} · ${d.cpu.count} 核${p ? `（${p}P+${e}E）` : ''} · 频率按利用率估算`
        : d.host.kind === 'win'
        ? `${d.cpu.model} · ${d.cpu.count} 核 · WMI 采样（SSH）`
        : `${d.cpu.model} · ${d.cpu.count} 核 · 真实频率（cpufreq）`;
    }
  },
  mem: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">物理内存</div><div class="info-value" id="mem-used">—</div></div>
          <div class="info-item"><div class="info-label">内存占用率</div><div class="info-value" id="mem-pct">—</div></div>
          <div class="info-item"><div class="info-label">缓存 (Cached)</div><div class="info-value" id="mem-cache">—</div></div>
          <div class="info-item"><div class="info-label">交换分区 (Swap)</div><div class="info-value" id="mem-swap">—</div></div>
        </div>
        <div class="section-title">内存构成</div><div id="mem-bars"></div>`;
    },
    update(d) {
      const m = d.mem;
      setText('mem-used', `${fmtSize(m.used)} / ${fmtSize(m.total)}`);
      setText('mem-pct', m.percent.toFixed(0) + '%');
      setText('mem-cache', fmtSize(m.cached));
      setText('mem-swap', m.swapTotal ? `${fmtSize(m.swapUsed)} / ${fmtSize(m.swapTotal)}` : '未启用');
      const rows = m.style === 'mac' ? [
        ['活跃 (active)', m.active || 0, '#bf5af2'],
        ['联动 (wired)', m.wired || 0, '#0a84ff'],
        ['压缩 (compressed)', m.compressed || 0, '#ff9f0a'],
        ['文件缓存 (cached)', m.cached || 0, '#30d158'],
        ['可用', m.avail || 0, 'rgba(235,240,248,0.3)']
      ] : m.style === 'win' ? [
        ['已使用', m.used || 0, '#bf5af2'],
        ['缓存 (Cached)', m.cached || 0, '#0a84ff'],
        ['提交内存 (Commit)', m.commit || 0, '#ff9f0a'],
        ['可用', m.avail || 0, 'rgba(235,240,248,0.3)']
      ] : [
        ['已使用（匿名）', m.anon, '#bf5af2'], ['缓存 + 可回收', m.cached, '#0a84ff'],
        ['共享内存 (shmem)', m.shmem, '#ffd60a'], ['缓冲区', m.buffers, '#30d158'],
        ['可用', m.avail, 'rgba(235,240,248,0.3)']
      ];
      const bar = document.getElementById('mem-bars');
      if (bar && bar.dataset.style !== m.style) {
        bar.innerHTML = rows.map((r, i) => `
          <div class="bar-row">
            <span class="bar-label">${r[0]}</span>
            <div class="bar-track"><div class="bar-fill" id="bar-mem-${i}" style="background:${r[2]}"></div></div>
            <span class="bar-num" id="bar-num-${i}">—</span>
          </div>`).join('');
        bar.dataset.style = m.style;
      }
      rows.forEach((r, i) => {
        const f = document.getElementById('bar-mem-' + i);
        if (f) f.style.width = Math.min(100, r[1] / m.total * 100).toFixed(1) + '%';
        setText('bar-num-' + i, fmtSize(r[1]));
      });
    },
    meta(d) { return `${fmtSize(d.mem.total)} 物理内存 · Swap ${fmtSize(d.mem.swapTotal)}`; }
  },
  disk: {
    build(d) {
      const combined = d && (d.disk.devices || []).some(x => x.combined);
      const cards = combined ? `
          <div class="info-item"><div class="info-label">合计吞吐（读+写）</div><div class="info-value" style="color:var(--cyan)" id="disk-total">—</div></div>
          <div class="info-item"><div class="info-label">IOPS</div><div class="info-value" style="color:var(--amber)" id="disk-tps">—</div></div>
          <div class="info-item"><div class="info-label">平均 IO 大小</div><div class="info-value" id="disk-kbt">—</div></div>
          <div class="info-item"><div class="info-label" id="disk-peak-label">窗口峰值</div><div class="info-value" id="disk-peak">—</div></div>` : `
          <div class="info-item"><div class="info-label">读取速率</div><div class="info-value" style="color:var(--cyan)" id="disk-r">—</div></div>
          <div class="info-item"><div class="info-label">写入速率</div><div class="info-value" style="color:var(--amber)" id="disk-w">—</div></div>
          <div class="info-item"><div class="info-label">合计吞吐</div><div class="info-value" id="disk-total">—</div></div>
          <div class="info-item"><div class="info-label" id="disk-peak-label">窗口峰值</div><div class="info-value" id="disk-peak">—</div></div>`;
      const devHead = combined
        ? '<tr><th>设备</th><th style="text-align:right">吞吐</th><th style="text-align:right">IOPS</th></tr>'
        : '<tr><th>设备</th><th style="text-align:right">读取</th><th style="text-align:right">写入</th></tr>';
      return `
        <div class="info-grid">${cards}</div>
        <div class="section-title">${''}块设备</div>
        <table class="vol-table">
          <thead id="dev-thead">${devHead}</thead>
          <tbody id="dev-tbody"></tbody>
        </table>
        <div class="section-title">挂载点容量</div>
        <table class="vol-table">
          <thead><tr><th>挂载点</th><th>容量</th><th style="text-align:right">可用</th></tr></thead>
          <tbody id="vol-tbody"></tbody>
        </table>`;
    },
    update(d) {
      const combined = (d.disk.devices || []).some(x => x.combined);
      if (combined) {
        setText('disk-total', fmtRate(d.disk.totalR));
        setText('disk-tps', d.disk.tps != null ? d.disk.tps.toFixed(0) + ' 次/秒' : '—');
        setText('disk-kbt', d.disk.kbt != null ? d.disk.kbt.toFixed(1) + ' KB' : '—');
      } else {
        setText('disk-r', fmtRate(d.disk.totalR));
        setText('disk-w', fmtRate(d.disk.totalW));
        setText('disk-total', fmtRate(d.disk.totalR + d.disk.totalW));
      }
      setText('disk-peak', fmtRate(Math.max(0, ...hist.disk.filter(isNum)) * 1048576));
      const tb = document.getElementById('dev-tbody');
      if (tb) tb.innerHTML = (d.disk.devices || []).map(v => combined ? `
        <tr>
          <td>${esc(v.name)} <span style="color:var(--text-3);font-size:11px">（整机合计）</span></td>
          <td style="text-align:right;color:var(--cyan)">${fmtRate(v.r)}</td>
          <td style="text-align:right;color:var(--amber)">${d.disk.tps != null ? d.disk.tps.toFixed(0) : '—'}</td>
        </tr>` : `
        <tr>
          <td>${esc(v.name)}</td>
          <td style="text-align:right;color:var(--cyan)">${fmtRate(v.r)}</td>
          <td style="text-align:right;color:var(--amber)">${fmtRate(v.w)}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="empty-hint">无块设备</td></tr>';
      const vt = document.getElementById('vol-tbody');
      if (vt) {
        const winHost = d.host.kind === 'win';
        vt.innerHTML = (d.disk.volumes || []).map(v => {
          const cls = winHost ? ' class="vol-row" data-root="' + esc(v.mount + '\\') + '"' : '';
          const hint = winHost ? ' <span style="color:var(--text-3);font-size:11px">› 浏览文件</span>' : '';
          return `
        <tr${cls}>
          <td>${esc(v.mount)}${hint}</td>
          <td>${fmtSize(v.used)} / ${fmtSize(v.total)}
            <span class="usage-track"><span class="usage-fill" style="width:${(v.used / v.total * 100).toFixed(0)}%"></span></span>
          </td>
          <td>可用 ${fmtSize(v.avail)}</td>
        </tr>`;
        }).join('') || '<tr><td colspan="3" class="empty-hint">无数据</td></tr>';
        [...vt.querySelectorAll('tr.vol-row')].forEach(tr => {
          tr.onclick = () => { openDir(tr.dataset.root); switchView('files'); };
        });
      }
    },
    meta(d) {
      return d.host.kind === 'local'
        ? '磁盘活动（iostat 1 秒窗口 · 合计口径：macOS 不区分读/写）'
        : '块设备吞吐（/proc/diskstats 1 秒窗口差分）';
    }
  },
  net: {
    build(d) {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">总接收 ↓</div><div class="info-value" style="color:#ffd60a" id="net-rx">—</div></div>
          <div class="info-item"><div class="info-label">总发送 ↑</div><div class="info-value" style="color:#ff453a" id="net-tx">—</div></div>
          <div class="info-item"><div class="info-label">主接口</div><div class="info-value" id="net-main">—</div></div>
          <div class="info-item"><div class="info-label">主接口累计</div><div class="info-value" id="net-tot">—</div></div>
        </div>
        <div class="section-title">网络接口（<span style="color:#ffd60a">黄=接收</span> / <span style="color:#ff453a">红=发送</span>）</div>
        <table class="vol-table">
          <thead><tr><th>接口</th><th>接收</th><th>发送</th><th>累计</th></tr></thead>
          <tbody id="net-tbody"></tbody>
        </table>`;
    },
    update(d) {
      const m = mainIface(d) || { name: '—', rx: 0, tx: 0, rxTotal: 0, txTotal: 0 };
      setText('net-rx', fmtRate(m.rx));
      setText('net-tx', fmtRate(m.tx));
      setText('net-main', m.name);
      setText('net-tot', `收 ${fmtSize(m.rxTotal)} / 发 ${fmtSize(m.txTotal)}`);
      const tb = document.getElementById('net-tbody');
      if (tb) tb.innerHTML = (d.net.ifaces || []).map(i => `
        <tr>
          <td>${esc(i.name)}</td>
          <td style="color:#ffd60a">↓ ${fmtRate(i.rx)}</td>
          <td style="color:#ff453a">↑ ${fmtRate(i.tx)}</td>
          <td>累计收 ${fmtSize(i.rxTotal)} / 发 ${fmtSize(i.txTotal)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty-hint">无接口</td></tr>';
    },
    meta(d) { const m = mainIface(d); return m ? `主接口 ${m.name}` : '无网络接口'; }
  },
  gpu: {
    build(d) {
      // 远程 Linux 核显（Intel i915/xe）：利用率来自 RC6 空闲驻留差分，频率走 rps_* 节点
      if (d.gpu && d.gpu.style === 'linux') {
        return `
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">GPU 利用率</div><div class="info-value" style="color:var(--cyan)" id="gpu-util">—</div></div>
          <div class="info-item"><div class="info-label">当前频率</div><div class="info-value" id="gpu-freq">—</div></div>
          <div class="info-item"><div class="info-label">最大频率</div><div class="info-value" id="gpu-freqmax">—</div></div>
          <div class="info-item"><div class="info-label">核显型号</div><div class="info-value" style="font-size:12.5px" id="gpu-name">—</div></div>
          <div class="info-item"><div class="info-label">驱动</div><div class="info-value" id="gpu-driver">—</div></div>
          <div class="info-item"><div class="info-label">显存</div><div class="info-value" style="font-size:12.5px" id="gpu-mem">—</div></div>
        </div>
        <div class="section-title">数据源：/sys/class/drm/card0/gt/gt0（RC6 空闲驻留差分 → 真实利用率，免 sudo）</div>`;
      }
      // Windows 独显（nvidia-smi）：利用率/功耗/温度/显存一步到位
      if (d.gpu && d.gpu.style === 'win') {
        return `
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">GPU 利用率</div><div class="info-value" style="color:var(--cyan)" id="gpu-util">—</div></div>
          <div class="info-item"><div class="info-label">实时功耗</div><div class="info-value" style="color:var(--orange)" id="gpu-power">—</div></div>
          <div class="info-item"><div class="info-label">功耗上限</div><div class="info-value" id="gpu-plimit">—</div></div>
          <div class="info-item"><div class="info-label">GPU 温度</div><div class="info-value" id="gpu-temp">—</div></div>
          <div class="info-item"><div class="info-label">显存</div><div class="info-value" style="font-size:12.5px" id="gpu-mem">—</div></div>
          <div class="info-item"><div class="info-label">型号</div><div class="info-value" style="font-size:12.5px" id="gpu-name">—</div></div>
          <div class="info-item"><div class="info-label">驱动版本</div><div class="info-value" style="font-size:12.5px" id="gpu-driver">—</div></div>
        </div>
        <div class="section-title">数据源：nvidia-smi（SSH 直采，NVIDIA 显卡专有）</div>`;
      }
      return `
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">GPU 利用率</div><div class="info-value" style="color:var(--cyan)" id="gpu-util">—</div></div>
          <div class="info-item"><div class="info-label">渲染器利用率</div><div class="info-value" id="gpu-ren">—</div></div>
          <div class="info-item"><div class="info-label">分块器利用率</div><div class="info-value" id="gpu-til">—</div></div>
          <div class="info-item"><div class="info-label">已用显存</div><div class="info-value" id="gpu-mem">—</div></div>
          <div class="info-item"><div class="info-label">GPU 核心数</div><div class="info-value" id="gpu-cores">—</div></div>
          <div class="info-item"><div class="info-label">图形接口</div><div class="info-value" style="font-size:12.5px" id="gpu-metal">—</div></div>
        </div>
        <div class="section-title">数据源：IOAccelerator 注册表（用户态可读）</div>`;
    },
    update(d) {
      const g = d.gpu || {};
      const p = (v) => (v === null || v === undefined) ? '—' : v.toFixed(1) + '%';
      if (g.style === 'win') {
        setText('gpu-util', p(g.util));
        setText('gpu-power', g.power !== null && g.power !== undefined ? g.power.toFixed(1) + ' W' : '—');
        setText('gpu-plimit', g.powerLimit ? g.powerLimit.toFixed(0) + ' W' : '—');
        setText('gpu-temp', g.temp !== null && g.temp !== undefined ? g.temp.toFixed(0) + ' ℃' : '—');
        setText('gpu-mem', (g.memUsed !== null && g.memTotal) ? `${fmtSize(g.memUsed)} / ${fmtSize(g.memTotal)}` : '—');
        setText('gpu-name', g.name || '—');
        setText('gpu-driver', g.driver || '—');
        return;
      }
      if (g.style === 'linux') {
        setText('gpu-util', p(g.util));
        setText('gpu-freq', g.freq > 0 ? g.freq + ' MHz'
          : (typeof g.util === 'number' && g.util < 5 ? '空闲' : '—'));
        setText('gpu-freqmax', g.freqMax ? g.freqMax + ' MHz' + (g.freqMin ? `（${g.freqMin}–${g.freqMax}）` : '') : '—');
        setText('gpu-name', g.name || '—');
        setText('gpu-driver', g.driver || '—');
        setText('gpu-mem', g.shared ? '共享系统内存（核显无独立显存）' : '—');
        return;
      }
      setText('gpu-util', p(g.util));
      setText('gpu-ren', p(g.renderer));
      setText('gpu-til', p(g.tiler));
      setText('gpu-mem', g.memBytes ? fmtSize(g.memBytes) : '—');
      setText('gpu-cores', g.cores ? g.cores + ' 核' : '—');
      setText('gpu-metal', g.metal || '—');
    },
    meta(d) {
      if (d.gpu && d.gpu.style === 'win') {
        const g = d.gpu;
        if (typeof g.util !== 'number') return 'GPU 数据采样中';
        return `GPU 利用率 ${g.util.toFixed(0)}%${g.power !== null && g.power !== undefined ? ' · ' + g.power.toFixed(1) + ' W' : ''}${g.temp !== null && g.temp !== undefined ? ' · ' + g.temp.toFixed(0) + '℃' : ''}${g.name ? ' · ' + g.name : ''}`;
      }
      if (d.gpu && d.gpu.style === 'linux') {
        const g = d.gpu;
        if (typeof g.util !== 'number') return 'GPU 数据采样中';
        return `GPU 利用率 ${g.util.toFixed(0)}%${g.freq > 0 ? ' · ' + g.freq + ' MHz' : ' · 空闲'}${g.name ? ' · ' + g.name : ''}`;
      }
      return (d.gpu && d.gpu.util !== null && d.gpu.util !== undefined) ? `GPU 利用率 ${d.gpu.util.toFixed(0)}%` : 'GPU 数据不可用';
    }
  },
  batt: {
    build() {
      return `
        <div class="info-grid cols-4">
          <div class="info-item"><div class="info-label">电量</div><div class="info-value" id="batt-pct">—</div></div>
          <div class="info-item"><div class="info-label">状态</div><div class="info-value" id="batt-state">—</div></div>
          <div class="info-item"><div class="info-label"><span id="batt-time-label">可用</span>时间</div><div class="info-value" id="batt-time">—</div></div>
          <div class="info-item"><div class="info-label"><span id="batt-est-label">预计使用</span></div><div class="info-value" id="batt-est">—</div></div>
          <div class="info-item"><div class="info-label">实时电流</div><div class="info-value" id="batt-amp">—</div></div>
          <div class="info-item"><div class="info-label">电压</div><div class="info-value" id="batt-volt">—</div></div>
          <div class="info-item"><div class="info-label">实时功率</div><div class="info-value" id="batt-watt">—</div></div>
          <div class="info-item"><div class="info-label">系统输入功率</div><div class="info-value" id="batt-sysin">—</div></div>
          <div class="info-item"><div class="info-label">充电器</div><div class="info-value" id="batt-adapter">—</div></div>
          <div class="info-item"><div class="info-label">电池健康</div><div class="info-value" id="batt-health">—</div></div>
          <div class="info-item"><div class="info-label">循环次数</div><div class="info-value" id="batt-cycle">—</div></div>
          <div class="info-item"><div class="info-label">电池容量</div><div class="info-value" id="batt-cap">—</div></div>
        </div>
        <div class="section-title">数据源：AppleSmartBattery（电压×电流 = 真实功率；曲线 = 充放电功率，充电在上/放电在下；预计使用/充满 = 电量变化 ÷ 当前电流）</div>`;
    },
    update(d) {
      const b = d.batt || {};
      setText('batt-pct', b.present ? b.percent + '%' : '—');
      const stateTxt = b.status === 'charging' ? '⚡ 充电中' : b.status === 'discharging' ? '🔋 放电中' : '🔌 已接通电源';
      setText('batt-state', b.present ? stateTxt : '无电池');
      setText('batt-time', b.timeRemaining || '—');
      setText('batt-time-label', b.status === 'charging' ? '充满' : '可用');
      setText('batt-amp', b.amperage !== null && b.amperage !== undefined
        ? (b.amperage > 0 ? '+' : '') + (b.amperage / 1000).toFixed(2) + ' A（' + (b.amperage > 0 ? '充入' : '输出') + '）' : '—');
      setText('batt-volt', b.voltage ? b.voltage.toFixed(2) + ' V' : '—');
      setText('batt-watt', b.watts !== null && b.watts !== undefined
        ? (b.watts > 0 ? '+' : '') + b.watts.toFixed(1) + ' W（' + (b.watts > 0 ? '充入' : '输出') + '）' : '—');
      // 预计使用 / 预计充满：剩余或缺口电荷(mAh) ÷ |当前电流|(mA)。
      // 瞬时电流在 PD 协商/负载波动时抖动大（曾出现 0.1A 毛刺 → 22 小时假值），
      // 因此：①丢弃电流过小的过渡拍；②攒够 3 个有效样本后取中位数，抗单点毛刺；
      // ③按数据签名去重，避免 2s 渲染帧重复推入同一拍样本。
      let estTxt = '—', estLabel = '预计使用';
      if (battEstState !== b.status) { battEstBuf = []; battEstAt = 0; battEstState = b.status; }
      if (b.present && b.nominal > 0 && b.percent > 0 && b.percent < 100 && b.amperage) {
        let hours = null, minAmp = 0;
        if (b.status === 'discharging' && b.amperage < 0) {
          hours = (b.percent / 100 * b.nominal) / -b.amperage;
          estLabel = '预计使用'; minAmp = 150;      // 放电 <150mA 多为静置毛刺
        } else if (b.status === 'charging' && b.amperage > 0) {
          hours = ((100 - b.percent) / 100 * b.nominal) / b.amperage;
          estLabel = '预计充满'; minAmp = 300;      // 充电 <300mA 是协商/爬坡期，算出来是假值
        }
        if (hours !== null && isFinite(hours) && hours > 0 && Math.abs(b.amperage) >= minAmp) {
          // 按时间间隔去重：电池数据 6s 才刷新一次，而本函数每 2s 被调用一次，
          // 不能用「值是否变化」判断（电量/电流稳定时会永远攒不满样本）。
          const now = Date.now();
          if (now - battEstAt >= 4000) {
            battEstBuf.push(hours);
            if (battEstBuf.length > 3) battEstBuf.shift();
            battEstAt = now;
          }
          if (battEstBuf.length >= 3) {
            const sorted = [...battEstBuf].sort((x, y) => x - y);
            const med = sorted[Math.floor(sorted.length / 2)];
            let h = Math.floor(med), m = Math.round((med - h) * 60);
            if (m === 60) { h++; m = 0; }   // x.999h 边界：round 出 60 分钟
            estTxt = med > 99 ? '99+ 小时' : (h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`);
          }
        }
      }
      setText('batt-est-label', estLabel);
      setText('batt-est', estTxt);
      // 「可用/充满时间」：pmset 有值用 pmset；充电时 pmset 常为 (no estimate)，用自算兜底
      if (!b.timeRemaining && estLabel === '预计充满' && estTxt !== '—') setText('batt-time', estTxt);
      else setText('batt-time', b.timeRemaining || '—');
      setText('batt-health', b.health ? b.health + '%' : '—');
      setText('batt-cycle', b.cycle !== null && b.cycle !== undefined ? b.cycle + ' 次' : '—');
      // 电池容量：满充标称 / 设计出厂（mAh）
      setText('batt-cap', b.nominal > 0 && b.design > 0 ? `${b.nominal} / ${b.design} mAh` : '—');
      // 充电器：额定功率 · 协商电压（仅接通电源时显示）
      setText('batt-adapter', b.adapterWatts > 0
        ? `${b.adapterWatts} W${b.adapterVolt ? ' · ' + b.adapterVolt.toFixed(1) + 'V' : ''}` : '—');
      // 系统输入功率：整机从适配器取电（含充电+系统负载+适配器损耗）
      setText('batt-sysin', b.sysPowerIn > 0 ? b.sysPowerIn.toFixed(1) + ' W' : '—');
    },
    meta(d) {
      const b = d.batt || {};
      if (!b.present) return '无电池';
      const dir = b.watts > 0 ? '充电输入' : '放电输出';
      let est = '';
      // 与详情页同源：优先用中位数样本，样本不足时用瞬时值但过滤协商/爬坡期的微小电流
      let hours = null;
      if (battEstState === b.status && battEstBuf.length >= 3) {
        const s = [...battEstBuf].sort((x, y) => x - y);
        hours = s[Math.floor(s.length / 2)];
      } else if (b.nominal > 0 && b.percent > 0) {
        if (b.status === 'discharging' && b.amperage <= -150) hours = (b.percent / 100 * b.nominal) / -b.amperage;
        else if (b.status === 'charging' && b.amperage >= 300) hours = ((100 - b.percent) / 100 * b.nominal) / b.amperage;
      }
      if (hours !== null && isFinite(hours) && hours > 0 && hours <= 99) {
        est = ` · 约 ${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} ${b.status === 'charging' ? '小时后充满' : '小时'}`;
      }
      return `${b.status === 'charging' ? '充电中' : b.status === 'discharging' ? '使用电池' : '已接通电源'} · ${dir} ${Math.abs(b.watts || 0).toFixed(1)} W${est}`;
    }
  },
  power: {
    build(d) {
      // Windows：LHM / PawnIO 读取 CPU 温度功耗，nvidia-smi 读取 GPU 功耗
      if (d.power && d.power.style === 'win') {
        return `
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">${d.power.partial ? '已知功耗合计' : '整机估算功耗'}</div><div class="info-value" style="color:var(--orange)" id="pw-pkg">—</div></div>
          <div class="info-item"><div class="info-label">CPU 封装功耗</div><div class="info-value" id="pw-cpu">—</div></div>
          <div class="info-item"><div class="info-label">CPU 温度（Tctl）</div><div class="info-value" id="pw-cupt">—</div></div>
          <div class="info-item"><div class="info-label">GPU 实时功耗</div><div class="info-value" id="pw-gpu">—</div></div>
          <div class="info-item"><div class="info-label">GPU 温度</div><div class="info-value" id="pw-temp">—</div></div>
          <div class="info-item"><div class="info-label">GPU 功耗上限</div><div class="info-value" id="pw-limit">—</div></div>
        </div>
        <div class="section-title">${d.power.partial ? '部分功耗数据不可用，仅合计可读取的分项' : '整机估算 = CPU 封装 + GPU 封装'}（主板 / 硬盘 / 风扇未计入）· 曲线：橙=功耗 / 红=CPU 温度</div>`;
      }
      return `
        <div class="info-grid cols-3">
          <div class="info-item"><div class="info-label">整机封装功耗</div><div class="info-value" style="color:var(--orange)" id="pw-pkg">—</div></div>
          <div class="info-item"><div class="info-label">CPU 核心功耗</div><div class="info-value" id="pw-cores">—</div></div>
          <div class="info-item"><div class="info-label">CPU 封装温度</div><div class="info-value" id="pw-temp">—</div></div>
          <div class="info-item"><div class="info-label">主板温度</div><div class="info-value" id="pw-acpi">—</div></div>
          <div class="info-item"><div class="info-label">无线网卡温度</div><div class="info-value" id="pw-wifi">—</div></div>
          <div class="info-item"><div class="info-label">数据源</div><div class="info-value" style="font-size:12.5px">Intel RAPL（真实寄存器）</div></div>
        </div>
        <div class="section-title">窗口内功耗 / 温度（<span style="color:var(--orange)">橙=功耗</span> / <span style="color:var(--red)">红=温度</span>）</div>`;
    },
    update(d) {
      if (d.power && d.power.style === 'win') {
        setText('pw-pkg', d.power.pkg.toFixed(1) + ' W');
        setText('pw-cpu', d.power.cpu !== null ? d.power.cpu.toFixed(1) + ' W' : '—');
        setText('pw-cupt', d.power.cpuTemp !== null ? d.power.cpuTemp.toFixed(1) + ' ℃' : '—');
        setText('pw-gpu', d.power.gpu !== null ? d.power.gpu.toFixed(1) + ' W' : '—');
        setText('pw-temp', d.power.gpuTemp !== null ? d.power.gpuTemp.toFixed(0) + ' ℃' : '—');
        setText('pw-limit', d.power.limit ? d.power.limit.toFixed(0) + ' W' : '—');
        return;
      }
      setText('pw-pkg', d.power.ok ? d.power.pkg.toFixed(2) + ' W' : '不可用');
      setText('pw-cores', d.power.ok ? d.power.cores.toFixed(2) + ' W' : '—');
      const t = d.power.temp || {};
      setText('pw-temp', t['x86_pkg_temp'] !== undefined ? t['x86_pkg_temp'].toFixed(1) + ' ℃' : '—');
      setText('pw-acpi', t['acpitz'] !== undefined ? t['acpitz'].toFixed(1) + ' ℃' : '—');
      const wifiKey = Object.keys(t).find(k => k.startsWith('iwlwifi'));
      setText('pw-wifi', wifiKey ? t[wifiKey].toFixed(1) + ' ℃' : '—');
    },
    meta(d) {
      if (d.power && d.power.style === 'win') {
        return `${d.power.partial ? '已知合计' : '整机估算'} ${d.power.pkg.toFixed(1)} W（CPU ${d.power.cpu !== null ? d.power.cpu.toFixed(0) : '—'} + GPU ${d.power.gpu !== null ? d.power.gpu.toFixed(0) : '—'}）`;
      }
      return d.power.ok ? `RAPL 实时功耗 · ${d.power.pkg.toFixed(1)} W` : 'RAPL 不可读（需 root 运行 agent）';
    }
  }
};

let builtKey = '';
function tickDetail(force) {
  if (!latest) return;
  const body = document.getElementById('detail-body');
  // 首次采样核心数可能为 0，之后核心数组就绪时需重建（否则每核图块永远缺失）
  const key = activeCard + ':' + (activeCard === 'cpu' ? (latest.cpu.cores || []).length : '');
  // 切回主机后的首帧核心数组可能还是空的：此时不要用「0 个图块」覆盖已有 DOM（避免闪一下空白）
  const coresPending = activeCard === 'cpu' && (latest.cpu.cores || []).length === 0 && (latest.cpu.count || 0) > 0;
  if ((!bodyBuilt || force || key !== builtKey) && (!coresPending || !body.firstElementChild)) {
    try { body.innerHTML = detailDefs[activeCard].build(latest); bodyBuilt = true; builtKey = key; }
    catch (e) { console.error('detail.build', e); return; }
  }
  try { detailDefs[activeCard].update(latest); } catch (e) { console.error('detail.update', e); }
  setText('detail-title', cardTitle(activeCard));
  try {
    const big = document.getElementById('bigchart');
    if (activeCard === 'net') {
      drawOverlaid(big, hist.netrx, hist.nettx, '#ffd60a', '#ff453a');
      setText('chart-max', fmtRate(Math.max(0.001, ...hist.netrx.filter(isNum), ...hist.nettx.filter(isNum))));
    } else if (activeCard === 'power') {
      drawSeries(big, hist.power, '#ff9f0a');
      const { ctx, w, h } = setupCanvas(big);
      const temps = hist.temp.filter(isNum);
      if (temps.length > 1) {
        const step = w / (HIST - 1);
        const x0 = w - (hist.temp.length - 1) * step;
        strokeSeries(ctx, hist.temp, x0, step, h, Math.max(...temps, 1) * 1.2, '#ff453a', false);
      }
      setText('chart-max', Math.max(0, ...hist.power.filter(isNum)).toFixed(1) + ' W');
    } else if (activeCard === 'gpu') {
      drawSeries(big, hist.gpu, '#64d2ff', 100);
      setText('chart-max', '100%');
    } else if (activeCard === 'batt') {
      drawBipolar(big, hist.batt, battPowerColor(latest));
      const battAbs = Math.max(0, ...hist.batt.filter(isNum).map(Math.abs));
      setText('chart-max', battAbs > 0 ? '±' + battAbs.toFixed(1) + ' W' : '');
    } else {
      const series = { cpu: hist.cpu, mem: hist.mem, disk: hist.disk };
      const yMax = activeCard === 'mem' ? 100 : undefined;
      drawSeries(big, series[activeCard], CARD_DEFS[activeCard].color, yMax);
      setText('chart-max', activeCard === 'mem' ? '100%'
        : activeCard === 'disk' ? fmtRate(Math.max(0, ...hist.disk.filter(isNum)) * 1048576) : '');
    }
  } catch (e) { console.error('detail.chart', e); }
  try { setText('detail-meta', detailDefs[activeCard].meta(latest)); } catch (e) { }
}

// ---------- 进程 ----------
const procSortLabels = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网速', energy: '能耗', pid: 'PID' };
function renderProcs(d) {
  const tbody = document.getElementById('proc-tbody');
  if (!tbody) return;
  const q = procQuery.toLowerCase();
  let list = d.procs.list || [];
  if (q) list = list.filter(p => (p.name || '').toLowerCase().includes(q) || String(p.pid).includes(q));
  const key = procSort;
  const metric = (p) => key === 'cpu' ? p.cpu : key === 'mem' ? p.rss : key === 'disk' ? (p.dr + p.dw)
    : key === 'net' ? (p.rx + p.tx) : key === 'energy' ? p.energy : p.pid;
  list = [...list].sort((a, b) => key === 'pid' ? a.pid - b.pid : metric(b) - metric(a));
  const shown = list.slice(0, 200);
  tbody.innerHTML = shown.map(p => {
    const dTotal = (p.dr || 0) + (p.dw || 0);
    const ioTxt = dTotal > 0 ? `R ${fmtRate(p.dr)} / W ${fmtRate(p.dw)}` : '<span style="opacity:.35">—</span>';
    const netTxt = ((p.rx || 0) + (p.tx || 0)) > 0
      ? `<span style="color:#ffd60a">↓ ${fmtRate(p.rx)}</span> <span style="color:#ff453a">↑ ${fmtRate(p.tx)}</span>`
      : '<span style="opacity:.35">—</span>';
    return `
    <tr${p.pseudo ? ' class="pseudo-row"' : ''}>
      <td class="td-num" style="color:var(--text-3)">${p.pid > 0 ? p.pid : '—'}</td>
      <td style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</td>
      <td class="td-num ${p.cpu > 20 ? 'cpu-hot' : ''}">${p.cpu.toFixed(1)}</td>
      <td class="td-num">${fmtSize(p.rss)}</td>
      <td class="td-num"><span class="io-detail">${ioTxt}</span></td>
      <td class="td-num">${netTxt}</td>
      <td class="td-num">${p.energy > 0.05 ? p.energy.toFixed(2) + ' W' : '<span style="opacity:.35">—</span>'}</td>
      <td style="text-align:right">${p.pseudo ? '' : `<button class="kill-btn" data-pid="${p.pid}">结束</button>`}</td>
    </tr>`;
  }).join('');
  setText('proc-summary', `显示 ${shown.length} / ${d.procs.count} 个进程 · 按 ${procSortLabels[key] || 'CPU'} 排序（点击表头切换）`);
  tbody.querySelectorAll('.kill-btn').forEach(btn => {
    btn.onclick = async () => {
      const r = await window.bridge.killProcess(parseInt(btn.dataset.pid, 10));
      toast(String(r || ''));
    };
  });
  document.querySelectorAll('#proc-table th.sortable').forEach(th => {
    th.classList.toggle('sort-active', th.dataset.sort === procSort);
  });
}

let toastTimer = null;
function toast(msg) {
  if (!msg) return;
  const el = document.getElementById('sb-right');
  if (!el) return;
  const old = el.textContent;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (latest) el.textContent = defaultRightText(latest); else el.textContent = old; }, 2600);
}

// ---------- 容器 ----------
function renderDocker(d) {
  const tbody = document.getElementById('docker-tbody');
  if (!tbody) return;
  const list = (d.docker && d.docker.containers) || [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-hint">正在采集容器数据…（打开本页后约 15 秒出现，需目标机运行 Docker）</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="td-num ${parseFloat(c.cpu) > 50 ? 'cpu-hot' : ''}">${esc(c.cpu)}</td>
      <td class="td-num">${esc(c.mem)}</td>
      <td class="td-num"><span class="io-detail">${esc(c.net)}</span></td>
      <td class="td-num"><span class="io-detail">${esc(c.io)}</span></td>
      <td class="td-num">${esc(c.pids)}</td>
    </tr>`).join('');
}

// ---------- 状态栏 ----------
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
function fmtTraffic(b) {
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}
function defaultRightText(d) {
  return `${d.procs.count ? '进程 ' + d.procs.count + ' · ' : ''}已运行 ${fmtUptime(d.sys.uptime || 0)}`;
}

// ---------- 视图 ----------
let currentView = 'perf';
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  document.getElementById('perf-view').classList.toggle('active', v === 'perf');
  document.getElementById('procs-view').classList.toggle('active', v === 'procs');
  document.getElementById('docker-view').classList.toggle('active', v === 'docker');
  document.getElementById('files-view').classList.toggle('active', v === 'files');
  try { window.bridge.setView(v); } catch (e) { }
  if (v === 'perf' && latest) tickDetail(true);
  if (v === 'procs' && latest) renderProcs(latest);
  if (v === 'docker' && latest) renderDocker(latest);
  if (v === 'files') { if (!filesPath) openDir('C:\\'); else openDir(filesPath, true); }
}
document.querySelectorAll('.tab').forEach(t => { t.onclick = () => switchView(t.dataset.view); });

// ---------- v2.1.0 文件浏览（Win 11 · SSH 采集，免装 agent） ----------
let filesPath = null;            // 当前目录，如 'C:\Users\xx'
let filesItems = [];
let filesDrive = null;           // { total, free }（仅盘根时有值）
let filesSel = null;             // 选中项 { name, isDir, size, path }
let filesRequest = 0, filesSession = 0;
function resetFilesForHostSwitch() {
  filesSession++; filesRequest++; filesBusy = false;
  filesPath = null; filesItems = []; filesDrive = null; filesSel = null; fileClip = null;
  document.getElementById('files-tbody').innerHTML = '';
  document.getElementById('files-crumbs').textContent = '';
  hideCtxMenu(); syncFilesButtons();
}
function filesContext() { return filesSession + ':' + filesPath; }
let filesBusy = false;           // 列目录请求进行中
let dlActive = false;            // 下载进行中

function winParentDir(p) {
  const s = p.replace(/\\+$/, '');
  if (s.length <= 2) return null;           // 已是盘根 C:\
  const i = s.lastIndexOf('\\');
  if (i < 2) return s.slice(0, 2) + '\\';   // 'C:\Users' → 'C:\'
  return s.slice(0, i);
}

function winJoin(a, b) { return a.endsWith('\\') ? a + b : a + '\\' + b; }

function renderFilesCrumbs(p) {
  const box = document.getElementById('files-crumbs');
  const parts = [];
  const re = /^(.:)(?:\\(.*))?$/s.exec(p);
  if (!re) { box.textContent = p; return; }
  parts.push({ label: re[1] + '\\', path: re[1] + '\\' });
  if (re[2]) {
    let acc = re[1] + '\\';
    re[2].split('\\').filter(Boolean).forEach(seg => { acc = winJoin(acc, seg); parts.push({ label: seg, path: acc }); });
  }
  box.innerHTML = parts.map((x, i) =>
    `<span class="crumb${i === parts.length - 1 ? ' current' : ''}" data-path="${esc(x.path)}">${esc(x.label)}</span>` +
    (i < parts.length - 1 ? '<span class="crumb-sep">›</span>' : '')
  ).join('');
  [...box.querySelectorAll('.crumb')].forEach(c => { c.onclick = () => openDir(c.dataset.path); });
  box.scrollLeft = box.scrollWidth;
}

function renderFilesRows() {
  const tb = document.getElementById('files-tbody');
  if (!filesItems.length) {
    tb.innerHTML = '<tr class="disabled-row"><td colspan="3" class="empty-hint">空目录</td></tr>';
    return;
  }
  tb.innerHTML = filesItems.map((it, idx) => {
    const icon = it.d ? '📁' : '📄';
    const size = it.d ? '—' : fmtSize(it.l || 0);
    return `<tr data-idx="${idx}">
      <td><span style="margin-right:7px">${icon}</span>${esc(it.n)}</td>
      <td class="th-num" style="color:${it.d ? 'var(--text-3)' : 'var(--text)'}">${size}</td>
      <td class="th-num" style="color:var(--text-3)">${esc(it.m || '')}</td>
      <td style="width:40px"><span class="f-act" data-idx="${idx}" title="下载到 Mac">⬇</span></td>
    </tr>`;
  }).join('');
  // 文件夹单击进入 / 文件单击选中
  [...tb.querySelectorAll('tr[data-idx]')].forEach(tr => {
    const it = filesItems[+tr.dataset.idx];
    tr.onclick = () => {
      if (it.d) { openDir(winJoin(filesPath, it.n)); return; }
      filesSel = { name: it.n, isDir: false, size: it.l || 0, path: winJoin(filesPath, it.n) };
      [...tb.querySelectorAll('tr')].forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      syncFilesButtons();
    };
    tr.ondblclick = () => { if (!it.d) startDownload({ name: it.n, isDir: false, size: it.l || 0, path: winJoin(filesPath, it.n) }); };
  });
  // 行尾 ⬇ 按钮：文件/目录都可下载（目录单击进入，⬇ 负责整目录下载）
  [...tb.querySelectorAll('.f-act')].forEach(sp => {
    sp.onclick = (ev) => {
      ev.stopPropagation();
      const it = filesItems[+sp.dataset.idx];
      startDownload({ name: it.n, isDir: !!it.d, size: it.l || 0, path: winJoin(filesPath, it.n) });
    };
  });
  // 剪切中的条目置灰提示
  if (fileClip && fileClip.op === 'cut') {
    const ci = filesItems.findIndex(x => winJoin(filesPath, x.n).toLowerCase() === fileClip.path.toLowerCase());
    if (ci >= 0 && tb.children[ci]) tb.children[ci].classList.add('cut-src');
  }
}

function syncFilesButtons() {
  document.getElementById('files-download').disabled = !(filesSel && !dlActive);
  document.getElementById('files-up').disabled = !filesPath || winParentDir(filesPath) === null;
}

function setFilesStatus(html) { document.getElementById('files-status').innerHTML = html; }

function filesInfoLine() {
  const n = filesItems.length;
  let s = `${filesPath} · ${n} 项`;
  if (filesDrive && filesDrive.total) s += ` · 可用 ${fmtSize(filesDrive.free)} / 共 ${fmtSize(filesDrive.total)}`;
  s += '　（文件夹单击进入 · 文件单击选中 · ⬇ 或双击下载）';
  return s;
}

async function openDir(p, keepOld) {
  if (!latest || latest.host.kind !== 'win') { setFilesStatus('文件浏览仅支持 Win 11 主机'); return; }
  const request = ++filesRequest, session = filesSession;
  filesBusy = true; filesSel = null;
  syncFilesButtons();
  if (!keepOld) setFilesStatus(`<span style="opacity:.7">读取 ${esc(p)} …</span>`);
  const t0 = Date.now();
  let r;
  try { r = await window.bridge.listWinDir(p); } catch (err) { r = { ok: false, err: err.message }; }
  if (request !== filesRequest || session !== filesSession) return;
  filesBusy = false;
  if (currentView !== 'files') return;
  if (!r || !r.ok) {
    setFilesStatus(`⚠ ${esc((r && r.err) || '读取失败')} — ${esc(p)}`);
    syncFilesButtons();
    return;
  }
  filesPath = p;
  filesItems = r.items || [];
  filesDrive = r.total ? { total: r.total, free: r.free } : null;
  renderFilesCrumbs(p);
  renderFilesRows();
  setFilesStatus(esc(filesInfoLine()) + ` · ${Date.now() - t0} ms`);
  syncFilesButtons();
}

async function startDownload(sel) {
  if (dlActive) return;
  dlActive = true; syncFilesButtons();
  setFilesStatus(`⬇ ${esc(sel.isDir ? '[目录] ' : '')}${esc(sel.name)} — 准备传输…（在弹出的窗口中选择保存位置）`);
  let r;
  try { r = await window.bridge.downloadWin(sel.path, sel.isDir, sel.size); }
  catch (err) { r = { ok: false, err: err.message }; }
  dlActive = false; syncFilesButtons();
  if (!r) { setFilesStatus('⚠ 未知错误'); return; }
  if (r.ok) setFilesStatus(`✅ 已保存到 ${esc(r.dest)}`);
  else if (r.err === '已取消') setFilesStatus(esc(filesInfoLine()));
  else setFilesStatus(`⚠ 下载失败：${esc(r.err || '未知错误')}`);
}

window.bridge.onDlProgress((d) => {
  if (d.note) { setFilesStatus(esc(d.note)); return; }
  if (d.done) return; // 结束态由 startDownload 统一处理
  let s;
  if (d.total) {
    const pct = Math.min(100, d.transferred / d.total * 100).toFixed(0);
    s = `⬇ 传输中 ${pct}% · ${fmtSize(d.transferred)} / ${fmtSize(d.total)} <span class="dl-bar"><span class="dl-fill" style="width:${pct}%"></span></span>`;
  } else {
    s = `⬇ 传输中 · 已传 ${fmtSize(d.transferred)}（目录，总量未知）`;
  }
  setFilesStatus(s);
});

document.getElementById('files-up').onclick = () => { const p = winParentDir(filesPath); if (p) openDir(p); };
document.getElementById('files-refresh').onclick = () => { if (filesPath) openDir(filesPath); };
document.getElementById('files-download').onclick = () => { if (filesSel) startDownload(filesSel); };

// ---------- v2.2.0 右键菜单 + 文件操作 ----------
let fileClip = null;   // { op: 'copy' | 'cut', path, isDir }
const ctxMenu = document.getElementById('ctx-menu');
const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/;
function winNameError(v) {
  if (!v || !v.trim()) return '名称不能为空';
  if (BAD_NAME.test(v)) return '名称包含 Windows 不支持的字符';
  if (/[. ]$/.test(v) || v === '.' || v === '..') return '名称不能以点或空格结尾';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)) return '这是 Windows 保留的设备名';
  return '';
}

function showCtxMenu(items, x, y) {
  ctxMenu.innerHTML = items.map(it => it === '-'
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" data-id="${it.id}">${esc(it.label)}</div>`).join('');
  ctxMenu.style.display = 'block';
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctxMenu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  [...ctxMenu.querySelectorAll('.ctx-item')].forEach(el => {
    el.onclick = () => {
      const it = items.find(i => i && i.id === el.dataset.id);
      hideCtxMenu();
      if (it && !it.disabled && it.fn) it.fn();
    };
  });
}
function hideCtxMenu() { ctxMenu.style.display = 'none'; }
window.addEventListener('click', hideCtxMenu);
window.addEventListener('blur', hideCtxMenu);
window.addEventListener('resize', hideCtxMenu);

function ctxBaseItems(it) {
  const p = winJoin(filesPath, it.n);
  return [
    ...(it.d ? [{ id: 'open', label: '进入', fn: () => openDir(p) }] : [{ id: 'dl', label: '下载到 Mac', fn: () => startDownload({ name: it.n, isDir: false, size: it.l || 0, path: p }) }]),
    ...(it.d ? [{ id: 'dl', label: '下载到 Mac（整目录）', fn: () => startDownload({ name: it.n, isDir: true, size: 0, path: p }) }] : []),
    '-',
    { id: 'copy', label: '复制', fn: () => { fileClip = { op: 'copy', path: p, isDir: it.d }; setFilesStatus(`已复制：${esc(p)}（到目标目录右键粘贴）`); } },
    { id: 'cut', label: '剪切', fn: () => { fileClip = { op: 'cut', path: p, isDir: it.d }; setFilesStatus(`已剪切：${esc(p)}（到目标目录右键粘贴）`); renderFilesRows(); } },
    ...(it.d ? [{ id: 'pastein', label: '粘贴到此处', disabled: !fileClip, fn: () => pasteClip(p) }] : []),
    '-',
    { id: 'rename', label: '重命名', fn: () => doRename(it) },
    { id: 'delete', label: '删除（送回收站）', danger: true, fn: () => doDelete(it) },
    '-',
    { id: 'copypath', label: '复制路径', fn: () => { navigator.clipboard.writeText(p); setFilesStatus(`路径已复制：${esc(p)}`); } }
  ];
}

function ctxBlankItems() {
  return [
    { id: 'paste', label: '粘贴到此处', disabled: !fileClip, fn: () => pasteClip(filesPath) },
    { id: 'mkdir', label: '新建文件夹', fn: () => doMkdir() },
    { id: 'upload', label: '上传文件（Mac → Win11）', fn: () => doUpload() },
    '-',
    { id: 'refresh', label: '刷新', fn: () => openDir(filesPath, true) }
  ];
}

document.getElementById('files-view').addEventListener('contextmenu', e => {
  if (!latest || latest.host.kind !== 'win') return;
  e.preventDefault();
  const tr = e.target.closest('#files-tbody tr[data-idx]');
  if (tr) {
    const it = filesItems[+tr.dataset.idx];
    showCtxMenu(ctxBaseItems(it), e.clientX, e.clientY);
  } else if (e.target.closest('#files-view')) {
    showCtxMenu(ctxBlankItems(), e.clientX, e.clientY);
  }
});

async function pasteClip(dst) {
  if (!fileClip) return;
  const clip = fileClip, context = filesContext();
  const op = clip.op, src = clip.path;
  const name = src.split(/[\\/]/).filter(Boolean).pop();
  const target = winJoin(dst, name);
  if (src.toLowerCase() === target.toLowerCase()) { setFilesStatus('⚠ 源与目标相同'); return; }
  setFilesStatus(`${op === 'copy' ? '复制' : '移动'} ${esc(name)} → ${esc(dst)} …`);
  const r = await window.bridge.fileOp(op === 'copy' ? 'copy' : 'move', src, target).catch(err => ({ ok: false, err: err.message }));
  if (context !== filesContext() || currentView !== 'files') return;
  if (!r.ok) { setFilesStatus(`⚠ 粘贴失败：${esc(r.err || '未知错误')}`); return; }
  if (op === 'cut' && fileClip === clip) { fileClip = null; renderFilesRows(); }
  setFilesStatus(`✅ 已${op === 'copy' ? '复制' : '移动'}到 ${esc(target)}`);
  openDir(dst, true);
}

// 输入弹窗：返回输入值或 null
function filesModal(title, defVal) {
  return new Promise((resolve) => {
    const m = document.getElementById('files-modal');
    const inp = document.getElementById('files-modal-input');
    const err = document.getElementById('files-modal-err');
    document.getElementById('files-modal-title').textContent = title;
    inp.value = defVal || '';
    err.textContent = '';
    m.style.display = 'flex';
    inp.focus(); inp.select();
    const close = (v) => { m.style.display = 'none'; inp.onkeydown = null; resolve(v); };
    document.getElementById('files-modal-ok').onclick = () => {
      const v = inp.value;
      const error = winNameError(v);
      if (error) { err.textContent = error; return; }
      close(v);
    };
    document.getElementById('files-modal-cancel').onclick = () => close(null);
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') document.getElementById('files-modal-ok').click();
      if (ev.key === 'Escape') close(null);
      ev.stopPropagation();
    };
    m.onmousedown = (ev) => { if (ev.target === m) close(null); };
  });
}

async function doRename(it) {
  const context = filesContext(), base = filesPath;
  const nn = await filesModal('重命名 — ' + it.n, it.n);
  if (!nn || nn === it.n || context !== filesContext()) return;
  const r = await window.bridge.fileOp('rename', winJoin(base, it.n), nn).catch(err => ({ ok: false, err: err.message }));
  if (context !== filesContext()) return;
  if (!r.ok) { setFilesStatus(`⚠ 重命名失败：${esc(r.err || '未知错误')}`); return; }
  setFilesStatus(`✅ 已重命名为 ${esc(nn)}`);
  openDir(filesPath, true);
}

async function doMkdir() {
  const context = filesContext(), base = filesPath;
  const nn = await filesModal('新建文件夹 — ' + filesPath, '新建文件夹');
  if (!nn || context !== filesContext()) return;
  const r = await window.bridge.fileOp('mkdir', winJoin(base, nn)).catch(err => ({ ok: false, err: err.message }));
  if (context !== filesContext()) return;
  if (!r.ok) { setFilesStatus(`⚠ 新建失败：${esc(r.err || '未知错误')}`); return; }
  setFilesStatus(`✅ 已创建文件夹 ${esc(nn)}`);
  openDir(filesPath, true);
}

async function doDelete(it) {
  const context = filesContext();
  const p = winJoin(filesPath, it.n);
  const ok = await window.bridge.confirmDialog('删除确认',
    `确定要把「${it.n}」移入回收站吗？`,
    it.d ? '整个文件夹将移入 Windows 回收站，可随时还原。' : '文件将移入 Windows 回收站，可随时还原。');
  if (context !== filesContext()) return;
  if (!ok) { setFilesStatus('已取消删除'); return; }
  setFilesStatus(`🗑 正在移入回收站：${esc(it.n)} …`);
  const r = await window.bridge.fileOp('delete', p).catch(err => ({ ok: false, err: err.message }));
  if (context !== filesContext()) return;
  if (!r.ok) { setFilesStatus(`⚠ 删除失败：${esc(r.err || '未知错误')}`); return; }
  setFilesStatus(`✅ 已移入回收站：${esc(it.n)}`);
  openDir(filesPath, true);
}

async function doUpload() {
  const context = filesContext();
  setFilesStatus('⬆ 选择要上传的文件…');
  const r = await window.bridge.uploadWin(filesPath).catch(err => ({ ok: false, err: err.message }));
  if (context !== filesContext() || currentView !== 'files') return;
  if (!r) { setFilesStatus('⚠ 上传失败'); return; }
  if (r.err === '已取消') { setFilesStatus(esc(filesInfoLine())); return; }
  if (r.ok) setFilesStatus(`✅ 已上传 ${r.count}/${r.total} 个文件到 ${esc(filesPath)}`);
  else setFilesStatus(`⚠ ${esc(r.err || '上传失败')}`);
  openDir(filesPath, true);
}
function selectCard(id) {
  if (!detailDefs[id]) return;
  activeCard = id; bodyBuilt = false;
  switchView('perf'); buildSidebar(); tickDetail(true);
}
// 启动直达：/tmp/tm_view 写主机 id 或页签名
window.__initView = async (v) => {
  const hosts = hostList.length ? hostList : ((await window.bridge.getHosts()).hosts || []);
  if (hosts.some(h => h.id === v)) {
    if (v !== currentHostId) await applyHostSwitch(v, hosts.find(h => h.id === v));
    renderHostSeg(); return;
  }
  if (['perf', 'procs', 'docker'].includes(v)) switchView(v);
  else selectCard(v);
};

document.getElementById('proc-search').addEventListener('input', e => {
  procQuery = e.target.value;
  if (latest) renderProcs(latest);
});
document.querySelectorAll('#proc-table th.sortable').forEach(th => {
  th.onclick = () => { procSort = th.dataset.sort; if (latest) renderProcs(latest); };
});
document.querySelectorAll('#poll-ctl button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#poll-ctl button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    const ms = parseInt(btn.dataset.ms, 10);
    try { window.bridge.setInterval(ms); } catch (e) { }
    // 远程档位变化立刻反映到横轴刻度（下一个数据帧也会带着新 interval 覆盖）
    if (latest && latest.host.kind !== 'local') { histIntervalMs = ms; updateAxisLabels(); }
  };
});
window.addEventListener('keydown', e => {
  if (e.metaKey && e.key === '1') { e.preventDefault(); switchView('perf'); }
  else if (e.metaKey && e.key === '2') { e.preventDefault(); switchView('procs'); }
  else if (e.metaKey && e.key === '3') { e.preventDefault(); if (latest && latest.host.kind === 'remote') switchView('docker'); }
  else if (e.metaKey && e.key === '4') { e.preventDefault(); if (latest && latest.host.kind === 'win') switchView('files'); }
  else if (e.key === 'Escape') {
    hideCtxMenu();
    const s = document.getElementById('proc-search');
    if (s.value) { s.value = ''; procQuery = ''; if (latest) renderProcs(latest); }
  }
  document.body.classList.toggle('cmd-down', e.metaKey);
});
window.addEventListener('keyup', e => { if (!e.metaKey) document.body.classList.remove('cmd-down'); });

// ---------- 主循环 ----------
// 本机后台常驻采样帧：看 N100 时也在喂本机的曲线缓存（纯本地、零流量），
// 这样切回本机时曲线是连续的，不会出现「看 N100 期间」的断档
window.bridge.onLocalHist((d) => {
  if (!d || !d.host || !d.cpu) return;
  if (!histHostId || histHostId === 'local') return;   // 本机激活时走 onStats 正常路径
  const h = histCache['local'] || (histCache['local'] = newHist());
  push(h.cpu, d.cpu.total);
  push(h.mem, d.mem.percent);
  push(h.disk, (d.disk.totalR + d.disk.totalW) / 1048576);
  const m = mainIface(d);
  push(h.netrx, m ? m.rx : 0);
  push(h.nettx, m ? m.tx : 0);
  if (d.gpu) push(h.gpu, typeof d.gpu.util === 'number' ? d.gpu.util : (h.gpu.length ? h.gpu[h.gpu.length - 1] : 0));
  if (d.batt) push(h.batt, typeof d.batt.watts === 'number' ? d.batt.watts : null);
  d.cpu.cores.forEach((v, i) => {
    if (!h.cores[i]) h.cores[i] = [];
    push(h.cores[i], v);
  });
});

window.bridge.onSamplingGap(() => {
  // 暂停期间没有样本，恢复时明确断开所有主机曲线。
  for (const h of new Set([hist, ...Object.values(histCache)])) markGap(h);
});

let connectionLost = false;
window.bridge.onStats((d) => {
  const hid = d.host && d.host.id;
  if (!hid) return;
  // 切换主机瞬间，上一台主机可能还有一帧在途：它的构建时间早于切换动作，
  // 丢弃它，避免把 A 主机的采样点画进 B 主机的曲线里
  if (histHostId && hid !== histHostId && switchAt) return;
  if (d.host.kind !== 'local' && !d.link.ok) {
    if (!connectionLost) markGap(hist);
    connectionLost = true;
    hideCtxMenu();
    document.getElementById('connection-hint').style.display = 'flex';
    document.getElementById('sb-dot').className = 'sb-dot bad';
    setText('sb-left', `连接中断，正在自动重试…（${d.host.name}）`);
    setText('sb-right', '当前数据不可用，恢复连接后自动刷新');
    return; // 不把旧值或零值当作新采样点，也不保留可操作的旧进程行。
  }
  connectionLost = false;
  document.getElementById('connection-hint').style.display = 'none';
  const hostChanged = hid !== currentHostId;
  if (hostChanged) {
    switchHist(hid);         // 保存旧主机曲线、恢复新主机曲线（幂等：点切换时已改绑过）
    currentHostId = hid;
    bodyBuilt = false; builtKey = '';
    if (!cardsFor(d).includes(activeCard)) activeCard = 'cpu';
    buildSidebarFor(d);
    document.getElementById('poll-ctl').classList.toggle('disabled', d.host.kind === 'local');
    renderHostSeg();         // 同步顶部主机 chips（含主进程自动切换的情形，保证高亮与实际一致）
  } else if (cardsFor(d).join(',') !== sidebarSig || cardTitle('power', d) !== sidebarPowerTitle) {
    // 卡片集合变了（例如远程首帧之后才拿到核显 GPU / 本机电池状态变化）也要重建侧栏，
    // 否则新出现的卡片永远不显示
    bodyBuilt = false; builtKey = '';
    if (!cardsFor(d).includes(activeCard)) activeCard = 'cpu';
    buildSidebarFor(d);
  }
  latest = d;
  histIntervalMs = (d.link && d.link.interval) || (d.host.kind === 'local' ? 2000 : histIntervalMs);
  updateAxisLabels();
  push(hist.cpu, d.cpu.total);
  push(hist.mem, d.mem.percent);
  push(hist.disk, (d.disk.totalR + d.disk.totalW) / 1048576);
  const m = mainIface(d);
  push(hist.netrx, m ? m.rx : 0);
  push(hist.nettx, m ? m.tx : 0);
  if (d.power) { push(hist.power, d.power.pkg); const tp = parseFloat(pkgTemp(d)); push(hist.temp, isNaN(tp) ? null : tp); }
  // GPU 首帧采样未就绪（util=null）时沿用上一值，避免曲线上出现假 0 尖谷
  if (d.gpu) push(hist.gpu, typeof d.gpu.util === 'number' ? d.gpu.util : (hist.gpu.length ? hist.gpu[hist.gpu.length - 1] : 0));
  if (d.batt) push(hist.batt, typeof d.batt.watts === 'number' ? d.batt.watts : null);
  d.cpu.cores.forEach((v, i) => {
    if (!hist.cores[i]) hist.cores[i] = [];
    push(hist.cores[i], v);
  });

  // 顶栏主机信息
  document.getElementById('osinfo').innerHTML =
    `${esc(d.sys.hostname || d.host.name)} · ${esc(d.sys.os || (d.host.kind === 'local' ? 'macOS' : d.host.kind === 'win' ? 'Windows' : 'Linux'))} · ${esc(d.cpu.model || '')}`;
  // 容器页：仅远程 Linux 主机可用；文件页：仅 Win 11 可用
  const noDocker = d.host.kind === 'local' || d.host.kind === 'win';
  const dockerTab = document.getElementById('tab-docker');
  dockerTab.style.display = noDocker ? 'none' : '';
  if (noDocker && currentView === 'docker') switchView('perf');
  const noFiles = d.host.kind !== 'win';
  document.getElementById('tab-files').style.display = noFiles ? 'none' : '';
  if (noFiles && currentView === 'files') switchView('perf');

  // 状态栏
  const dot = document.getElementById('sb-dot');
  dot.className = 'sb-dot' + (d.link.ok ? '' : ' bad');
  if (d.host.kind === 'local') {
    setText('sb-left', `本机直采 · ${d.host.name} · 每 2 秒刷新${d.procs.count ? ' · ' + d.procs.count + ' 个进程' : ''}`);
  } else if (d.host.kind === 'win') {
    setText('sb-left', d.link.ok
      ? `已连接 ${d.host.name}（SSH · ${d.link.host}） · 采样 ${d.link.rtt} ms · 轮询 ${(d.link.interval / 1000).toFixed(0)} 秒 · 本次会话已用流量 ${fmtTraffic(d.link.bytes)}`
      : `连接中断，正在重试…（${d.host.name} · SSH）`);
  } else {
    setText('sb-left', d.link.ok
      ? `已连接 ${d.link.host} · 延迟 ${d.link.rtt} ms · 轮询 ${(d.link.interval / 1000).toFixed(0)} 秒 · 本次会话已用流量 ${fmtTraffic(d.link.bytes)}（${d.link.polls} 次请求）`
      : `连接中断，正在重试…（${d.link.host}）`);
  }
  setText('sb-right', defaultRightText(d));

  updateSidebar(d);
  if (currentView === 'perf') tickDetail();
  if (currentView === 'procs') renderProcs(d);
  if (currentView === 'docker') renderDocker(d);
});

renderHostSeg();
buildSidebar();
switchView('perf');
