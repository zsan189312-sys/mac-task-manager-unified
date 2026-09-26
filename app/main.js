// 任务管理器-统一版：一个 App 同时管理「本机 Mac」与「远程 Linux 主机（N100 等）」
// 数据源抽象：
//   local  —— 本机直采（Swift 助手 + vm_stat/iostat/netstat/ioreg/nettop）
//   remote —— 远程 n100_agent（HTTP + gzip，按需采集，省流量）
const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const { exec } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

app.setName('任务管理器-统一版');
nativeTheme.themeSource = 'dark'; // 锁定深色：浅色模式下毛玻璃会让文字不可读

// ---------------------------------------------------------------- 配置
const DEFAULT_CFG = {
  hosts: [
    { id: 'local', name: '本机 Mac', kind: 'local' },
    { id: 'n100', name: 'N100', kind: 'remote', host: '100.111.73.34', port: 9100 }
  ],
  activeHost: 'local',
  intervalMs: 5000,   // 远程轮询间隔（省流量）
  procTop: 80         // 远程进程表最多取多少条
};
const CFG_PATH = path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    const out = Object.assign({}, DEFAULT_CFG, c);
    // 本机条目始终存在且不可删除
    if (!Array.isArray(out.hosts) || !out.hosts.length) out.hosts = DEFAULT_CFG.hosts.slice();
    if (!out.hosts.some(h => h.id === 'local')) out.hosts.unshift(DEFAULT_CFG.hosts[0]);
    return out;
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
}
function saveCfg(c) { try { fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2)); } catch (e) { } }
let cfg = loadCfg();
let currentHost = cfg.hosts.find(h => h.id === cfg.activeHost) || cfg.hosts[0];

let wantProcs = false;      // 进程页是否打开（远程按需采集）
let wantDocker = false;     // 容器页是否打开
let polls = 0;

// ================================================================ 通用工具
function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
const KB = 1024, MB = KB * 1024, GB = MB * 1024;

// ================================================================ 本机采集
const CPU_HELPER = path.join(__dirname, 'bin', 'cpucores');
const PROCINFO = path.join(__dirname, 'bin', 'procinfo');

let staticInfo = null;      // 本机静态信息
let lastCoreTicks = null;   // 每核 [user, system, idle, nice]
let lastHostFrac = null;    // 机器级 { user, sys }（0-1）
let lastIfaces = null;
let lastNetTime = 0;
let lastProcRaw = null;
let lastProcsTime = 0;
let lastProcCpu = null;
let liveNet = {};           // nettop 常驻流每进程累计字节

// Apple Silicon 无用户态频率接口：按利用率在 [基础, 睿频] 区间估算
const FREQ = { pIdle: 700, pMax: 4410, eIdle: 600, eMax: 2600 }; // MHz（M4：P≤4.41GHz / E~2.6GHz）

async function localStatic() {
  const [brand, cores, memsize, ver, boot, perf, eff] = await Promise.all([
    run('sysctl -n machdep.cpu.brand_string'),
    run('sysctl -n hw.ncpu'),
    run('sysctl -n hw.memsize'),
    run('sw_vers -productVersion'),
    run('sysctl -n kern.boottime'),
    run('sysctl -n hw.perflevel0.physicalcpu 2>/dev/null'),
    run('sysctl -n hw.perflevel1.physicalcpu 2>/dev/null')
  ]);
  let bootSec = 0;
  const m = boot.match(/sec\s*=\s*(\d+)/);
  if (m) bootSec = parseInt(m[1], 10);
  const perfCount = parseInt(perf, 10) || 0;
  const effCount = parseInt(eff, 10) || 0;
  const ncpu = parseInt(cores, 10) || (perfCount + effCount);
  const coreTypes = [];
  for (let i = 0; i < ncpu; i++) coreTypes.push(perfCount > 0 && i < perfCount ? 'P' : 'E');
  return {
    chip: brand.trim() || 'Apple Silicon',
    cores: ncpu, perfCount, effCount, coreTypes,
    memTotal: parseInt(memsize, 10) || 16 * GB,
    osVersion: ver.trim(), bootSec,
    hostname: require('os').hostname()
  };
}

async function localCPU() {
  const out = await run('"' + CPU_HELPER + '"', 5000);
  let coreLoads = [], pUsage = null, eUsage = null;
  let usage = 0, user = 0, sys = 0, idle = 100;
  const lines = out.trim().split('\n');
  if (lines.length >= 2 && !out.startsWith('ERR')) {
    const ticks = [];
    for (let i = 1; i < lines.length; i++) {
      const nums = lines[i].trim().split(/\s+/).map(Number);
      if (nums.length === 4 && nums.every(n => !isNaN(n))) ticks.push(nums);
    }
    if (lastCoreTicks && lastCoreTicks.length === ticks.length) {
      const bs = { b: 0, u: 0, s: 0, t: 0 };
      coreLoads = ticks.map((t, i) => {
        const p = lastCoreTicks[i];
        const du = t[0] - p[0], ds = t[1] - p[1], dn = t[3] - p[3], di = t[2] - p[2];
        const busy = du + ds + dn, total = busy + di;
        bs.b += busy; bs.u += du; bs.s += ds; bs.t += total;
        return total > 0 ? (busy / total) * 100 : 0;
      });
      if (bs.t > 0) {
        usage = (bs.b / bs.t) * 100;
        user = ((bs.u + (bs.b - bs.u - bs.s)) / bs.t) * 100; // nice 并入用户（与活动监视器一致）
        sys = (bs.s / bs.t) * 100;
        idle = 100 - usage;
        lastHostFrac = { user: usage / 100 - (bs.s / bs.t), sys: bs.s / bs.t };
      }
      const types = staticInfo ? staticInfo.coreTypes : null;
      if (types && types.length === coreLoads.length) {
        const ps = [], es = [];
        coreLoads.forEach((v, i) => (types[i] === 'P' ? ps : es).push(v));
        if (ps.length) pUsage = ps.reduce((a, b) => a + b, 0) / ps.length;
        if (es.length) eUsage = es.reduce((a, b) => a + b, 0) / es.length;
      }
    }
    lastCoreTicks = ticks;
  }
  const loadRaw = await run('sysctl -n vm.loadavg');
  const load = (loadRaw.match(/\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/) || []).slice(1).map(Number);
  return { usage, user, sys, idle, coreLoads, pUsage, eUsage, loadAvg: load.length ? load : [0, 0, 0] };
}

async function localMem() {
  const [vmStat, swap] = await Promise.all([run('vm_stat'), run('sysctl -n vm.swapusage')]);
  const page = 16384;
  const get = (name) => {
    const m = vmStat.match(new RegExp(name + ':\\s+(\\d+)'));
    return m ? parseInt(m[1], 10) * page : 0;
  };
  const free = get('Pages free'), active = get('Pages active'), inactive = get('Pages inactive');
  const wired = get('Pages wired down'), compressed = get('Pages occupied by compressor');
  const purgeable = get('Pages purgeable'), speculative = get('Pages speculative');
  const total = (staticInfo && staticInfo.memTotal) || 16 * GB;
  const used = Math.min(total, active + wired + compressed + Math.max(0, inactive - purgeable));
  const sm = swap.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/);
  return {
    total, used, avail: Math.max(0, total - used),
    active, wired, compressed, inactive, free, purgeable, speculative,
    swapTotal: sm ? parseFloat(sm[1]) * MB : 0,
    swapUsed: sm ? parseFloat(sm[2]) * MB : 0
  };
}

async function localDiskIO() {
  const out = await run('iostat -c 2 -d disk0', 5000);
  const rows = out.trim().split('\n');
  let mbps = 0;
  if (rows.length >= 3) {
    const cols = rows[rows.length - 1].trim().split(/\s+/);
    if (cols.length >= 4) mbps = parseFloat(cols[cols.length - 1]) || 0;
  }
  return mbps * MB; // macOS 的 iostat 不区分读/写，故按合计处理
}

async function localVolumes() {
  const out = await run('df -k / /System/Volumes/VM /System/Volumes/Preboot /System/Volumes/Data 2>/dev/null');
  const seen = new Set(), volumes = [];
  out.trim().split('\n').slice(1).forEach(line => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) return;
    const mount = cols.slice(8).join(' ');
    if (seen.has(mount)) return;
    seen.add(mount);
    const total = parseInt(cols[1], 10) * KB, used = parseInt(cols[2], 10) * KB, avail = parseInt(cols[3], 10) * KB;
    if (total <= 0) return;
    volumes.push({ name: mount === '/' ? 'Macintosh HD' : mount.replace('/System/Volumes/', '').replace('/Volumes/', ''), mount, total, used, avail });
  });
  return volumes;
}

async function localNet() {
  const out = await run('netstat -ib');
  const t0 = Date.now();
  const now = {};
  out.trim().split('\n').slice(1).forEach(line => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) return;
    const name = cols[0];
    if (!/^en\d+$/.test(name)) return;
    // 同一接口会有多行（Link / IPv4 / IPv6），字节数是同一份计数器，只取第一行，否则会重复累加数倍
    if (now[name]) return;
    // 列：Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    now[name] = { ibytes: parseInt(cols[6], 10) || 0, obytes: parseInt(cols[9], 10) || 0 };
  });
  const dt = lastNetTime ? Math.max(0.5, (t0 - lastNetTime) / 1000) : 0;
  const ifaces = [];
  for (const [name, cur] of Object.entries(now)) {
    let rxRate = 0, txRate = 0;
    if (lastIfaces && lastIfaces[name] && dt > 0) {
      rxRate = Math.max(0, cur.ibytes - lastIfaces[name].ibytes) / dt;
      txRate = Math.max(0, cur.obytes - lastIfaces[name].obytes) / dt;
    }
    ifaces.push({ name, rx: rxRate, tx: txRate, rxTotal: cur.ibytes, txTotal: cur.obytes });
  }
  lastIfaces = now;
  lastNetTime = t0;
  ifaces.sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx));
  return ifaces;
}

async function localBattery() {
  const out = await run('pmset -g batt');
  const pct = (out.match(/(\d+)%/) || [])[1];
  const time = (out.match(/(\d+:\d+)\s+remaining/) || [])[1] || '';
  const io = await run('ioreg -r -c AppleSmartBattery -w 0 2>/dev/null', 5000);
  const num = (k) => {
    const m = io.match(new RegExp('"' + k + '"\\s*=\\s*(-?\\d+)'));
    if (!m) return null;
    let n = parseInt(m[1], 10);
    if (n > 9007199254740991) n = n - Math.pow(2, 64); // 放电电流被打成 64 位无符号
    return n;
  };
  const bool = (k) => new RegExp('"' + k + '"\\s*=\\s*Yes').test(io);
  const voltage = num('Voltage'), amperage = num('InstantAmperage');
  const external = bool('ExternalConnected'), isCharging = bool('IsCharging');
  const nom = num('NominalChargeCapacity'), des = num('DesignCapacity');
  return {
    percent: pct ? parseInt(pct, 10) : null,
    present: !!pct, external, charging: isCharging,
    status: !external ? 'discharging' : (isCharging ? 'charging' : 'external'),
    timeRemaining: time,
    voltage: voltage ? voltage / 1000 : null,
    amperage, watts: voltage && amperage ? (voltage * amperage) / 1e6 : null,
    cycle: num('CycleCount'),
    health: nom && des ? Math.round(nom / des * 1000) / 10 : null
  };
}

async function localGPU() {
  const out = await run('ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | grep -E "Device Utilization|Renderer Utilization|Tiler Utilization|In use system memory\\""', 5000);
  const get = (k) => {
    const m = out.match(new RegExp('"' + k + '"\\s*=\\s*([\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  };
  return { util: get('Device Utilization %'), renderer: get('Renderer Utilization %'), tiler: get('Tiler Utilization %'), memBytes: get('In use system memory') };
}

function startNetStream() {
  try {
    const child = exec('nettop -P -x -l 0', { maxBuffer: 128 * 1024 * 1024 }, () => { });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        // 行格式：时间  进程名.pid  bytes_in  bytes_out …
        // 进程名可能含空格（如 "Google Chrome Helper.1234"），故用正则从行中提取，而不是按空格切第 2 列
        const m = line.match(/^\S+\s+(.+)\.(\d+)\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const pid = m[2];
        if (!liveNet[pid]) liveNet[pid] = { rx: 0, tx: 0 };
        liveNet[pid].rx = parseInt(m[3], 10) || 0;
        liveNet[pid].tx = parseInt(m[4], 10) || 0;
      }
    });
    child.on('exit', () => { setTimeout(startNetStream, 5000); });
  } catch (e) { /* 网速列降级为 — */ }
}

async function localProcs() {
  const now = Date.now();
  const elapsed = lastProcsTime > 0 ? (now - lastProcsTime) / 1000 : 0;
  const iv = elapsed > 0.5 ? elapsed : 2;
  const out = await run('"' + PROCINFO + '"', 8000);
  const cur = {};
  const lines = out.trim().split('\n').filter(Boolean);
  lines.forEach(line => {
    const p = line.split('\t');
    if (p.length < 8) return;
    cur[p[0]] = { cpuNs: Math.max(+p[1] || 0, +p[2] || 0), dR: +p[3], dW: +p[4], wk: +p[5], rss: +p[6], path: p[7] || '' };
  });
  if (lines.length < 30) return localProcsFallback(iv, now);

  // ps 补充源：macOS 27 的 taskinfo/rusage 不计 darwinbg/nice 线程，ps pcpu 能看到
  const psCpu = {};
  try {
    const psOut = await run('ps -axo pid=,pcpu=', 5000);
    psOut.trim().split('\n').forEach(line => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)$/);
      if (m) psCpu[m[1]] = parseFloat(m[2]);
    });
  } catch (e) { }

  const ncpu = (staticInfo && staticInfo.cores) || 10;
  const procs = [];
  let attrFrac = 0;
  for (const [pid, c] of Object.entries(cur)) {
    const prev = lastProcRaw ? lastProcRaw[pid] : null;
    const nPrev = liveNet[pid];
    let cpu = 0, diskRead = 0, diskWrite = 0, rx = 0, tx = 0, wkRate = 0;
    if (prev) {
      cpu = Math.max(0, (c.cpuNs - prev.cpuNs) / 1e9 / iv * 100);
      diskRead = Math.max(0, (c.dR - prev.dR) / iv);
      diskWrite = Math.max(0, (c.dW - prev.dW) / iv);
      wkRate = Math.max(0, (c.wk - prev.wk) / iv);
    }
    const psVal = psCpu[pid] || 0;
    if (psVal > cpu) cpu = psVal;
    cpu = Math.min(100, cpu / ncpu);                 // 换算为占整机容量百分比
    const energy = (cpu / 100) * 20 + wkRate * 0.05; // M4 全核满载 CPU 约 20W
    attrFrac += cpu / 100;
    if (nPrev) {
      rx = Math.max(0, (nPrev.rx - (prev ? (prev.rx0 || 0) : 0)) / iv);
      tx = Math.max(0, (nPrev.tx - (prev ? (prev.tx0 || 0) : 0)) / iv);
    }
    const full = c.path || '';
    const name = full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : (full || '(未知)');
    procs.push({ pid: parseInt(pid, 10), name, cpu, rss: c.rss, dr: diskRead, dw: diskWrite, rx, tx, energy });
  }
  const realCount = procs.length;
  if (lastHostFrac && lastProcRaw) {
    const kernelPct = Math.max(0, lastHostFrac.sys) * 100;
    const protPct = Math.max(0, lastHostFrac.user - attrFrac) * 100;
    procs.push({ pid: 0, name: 'kernel_task（内核）', cpu: kernelPct, rss: 0, dr: 0, dw: 0, rx: 0, tx: 0, energy: kernelPct / 100 * 20, pseudo: true });
    procs.push({ pid: -1, name: '系统进程（受保护·聚合估算）', cpu: protPct, rss: 0, dr: 0, dw: 0, rx: 0, tx: 0, energy: protPct / 100 * 20, pseudo: true });
  }
  procs.sort((a, b) => b.cpu - a.cpu);
  const rawWithNet = {};
  for (const [pid, c] of Object.entries(cur)) {
    rawWithNet[pid] = Object.assign({}, c, { rx0: liveNet[pid] ? liveNet[pid].rx : 0, tx0: liveNet[pid] ? liveNet[pid].tx : 0 });
  }
  lastProcRaw = rawWithNet;
  lastProcsTime = now;
  return { count: realCount, list: procs.slice(0, 300) };
}

async function localProcsFallback(iv, now) {
  const [nameOut, timeOut, memOut] = await Promise.all([
    run('ps -axo pid=,comm=', 8000), run('ps -axo pid=,time=', 8000), run('ps -axo pid=,rss=', 8000)
  ]);
  const names = {};
  nameOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) names[m[1]] = m[2].trim();
  });
  const cur = {};
  timeOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^\s*(\d+)\s+(?:(\d+)-)?([\d:.]+)$/);
    if (m) {
      const days = m[2] ? parseInt(m[2], 10) * 86400 : 0;
      const parts = m[3].split(':').map(parseFloat);
      let secs = days;
      if (parts.length === 3) secs += parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) secs += parts[0] * 60 + parts[1];
      cur[m[1]] = secs;
    }
  });
  const rssMap = {};
  memOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rssMap[m[1]] = parseInt(m[2], 10) * KB;
  });
  const procs = [];
  for (const [pid, secs] of Object.entries(cur)) {
    const full = names[pid] || '(未知)';
    let cpu = 0;
    if (lastProcCpu && lastProcCpu[pid] !== undefined) cpu = Math.max(0, (secs - lastProcCpu[pid]) / iv * 100);
    procs.push({ pid: parseInt(pid, 10), name: full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : full, cpu, rss: rssMap[pid] || 0, dr: 0, dw: 0, rx: 0, tx: 0, energy: cpu });
  }
  procs.sort((a, b) => b.cpu - a.cpu);
  lastProcCpu = cur;
  lastProcsTime = now;
  return { count: procs.length, list: procs.slice(0, 300) };
}

// 本机轮询缓存
let lTick = 0;
let lCPU = null, lMem = null, lDisk = 0, lVolumes = [], lNet = [], lGPU = null, lBatt = { present: false }, lProcs = { count: 0, list: [] };

async function pollLocal() {
  lTick++;
  const [cpu, mem, disk, net, gpu] = await Promise.all([
    localCPU(), localMem(), localDiskIO(), localNet(), localGPU()
  ]);
  lCPU = cpu; lMem = mem; lDisk = disk; lNet = net; lGPU = gpu;
  if (lTick === 1 || lTick % 3 === 1) lBatt = await localBattery();
  if (lTick === 1 || lTick % 15 === 1) lVolumes = await localVolumes();
  if (lTick === 1 || lTick % 3 === 0) lProcs = await localProcs();
}

function buildLocalPayload() {
  const st = staticInfo || {};
  const cpu = lCPU || { usage: 0, user: 0, sys: 0, idle: 100, coreLoads: [], pUsage: null, eUsage: null, loadAvg: [0, 0, 0] };
  const mem = lMem || { total: st.memTotal || 16 * GB, used: 0, avail: 0, active: 0, wired: 0, compressed: 0, inactive: 0, swapTotal: 0, swapUsed: 0 };
  const types = st.coreTypes || [];
  const freq = cpu.coreLoads.map((v, i) => {
    const isP = types[i] === 'P';
    const idleF = isP ? FREQ.pIdle : FREQ.eIdle, maxF = isP ? FREQ.pMax : FREQ.eMax;
    return idleF + (v / 100) * (maxF - idleF);
  });
  const uptime = Math.max(0, Math.floor(Date.now() / 1000) - (st.bootSec || 0));
  return {
    host: { id: 'local', name: '本机 Mac', kind: 'local' },
    ts: Date.now(),
    link: { ok: true, rtt: 0, bytes: 0, polls: polls, interval: 2000, host: st.hostname || 'localhost', mode: '本机直采' },
    cpu: {
      cores: cpu.coreLoads, count: st.cores || cpu.coreLoads.length, total: cpu.usage,
      user: cpu.user, sys: cpu.sys, idle: cpu.idle, iowait: 0,
      freq, freqMax: FREQ.pMax, freqP: cpu.pUsage, freqE: cpu.eUsage,
      coreTypes: types, pUsage: cpu.pUsage, eUsage: cpu.eUsage,
      load: cpu.loadAvg, model: st.chip || ''
    },
    mem: Object.assign({}, mem, {
      percent: mem.total ? mem.used / mem.total * 100 : 0,
      cached: mem.inactive || 0, buffers: mem.speculative || 0, shmem: 0, anon: mem.active || 0,
      style: 'mac'
    }),
    disk: { devices: [{ name: 'disk0', r: lDisk, w: 0, combined: true }], totalR: lDisk, totalW: 0, volumes: lVolumes },
    net: { ifaces: lNet },
    gpu: (lGPU && lGPU.util !== null) ? Object.assign({}, lGPU, { cores: (st.gpu && st.gpu.cores) || null, metal: (st.gpu && st.gpu.metal) || null }) : null,
    batt: (lBatt && lBatt.present) ? lBatt : null,
    power: null,
    sys: { hostname: st.hostname || '', os: 'macOS ' + (st.osVersion || ''), kernel: '', uptime, model: st.chip || '' },
    procs: lProcs,
    docker: null
  };
}

// ================================================================ 远程采集
let rSnap = null, rProcs = { list: [], count: 0 }, rDocker = { containers: [] };
let rBytes = 0, rRtt = 0, rOk = false, rFail = 0;
let rLastProcFetch = 0, rLastDockerFetch = 0;

function getJSON(p) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({
      host: currentHost.host, port: currentHost.port, path: p, method: 'GET', timeout: 8000,
      headers: { 'Accept-Encoding': 'gzip', 'Connection': 'keep-alive' }
    }, (res) => {
      const chunks = []; let raw = 0;
      res.on('data', c => { chunks.push(c); raw += c.length; });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf); } catch (e) { }
        // 会话流量尽量贴近网卡真实字节：响应体（压缩后）+ 响应头 + 请求头/TCP/IP 头估算（约 240B）
        const hdrBytes = (res.rawHeaders || []).reduce((a, h) => a + Buffer.byteLength(String(h)) + 2, 0);
        rBytes += raw + hdrBytes + 240;
        try { resolve({ ok: true, data: JSON.parse(buf.toString('utf8')), ms: Date.now() - t0 }); }
        catch (e) { resolve({ ok: false, ms: Date.now() - t0 }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

function postJSON(p, obj) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request({
      host: currentHost.host, port: currentHost.port, path: p, method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { rBytes += body.length; resolve({ ok: res.statusCode === 200, body: d }); });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(body); req.end();
  });
}

async function pollRemote() {
  const r = await getJSON('/api/snapshot');
  if (r.ok) { rOk = true; rFail = 0; rRtt = r.ms; rSnap = r.data; }
  else { rFail++; if (rFail >= 2) rOk = false; }
  const now = Date.now();
  if (wantProcs && now - rLastProcFetch >= Math.max(cfg.intervalMs, 3000)) {
    const rp = await getJSON('/api/procs?top=' + cfg.procTop);
    if (rp.ok) rProcs = rp.data;
    rLastProcFetch = now;
  }
  if (wantDocker && now - rLastDockerFetch >= 15000) {
    const rd = await getJSON('/api/docker');
    if (rd.ok) rDocker = rd.data;
    rLastDockerFetch = now;
  }
}

function buildRemotePayload() {
  const s = rSnap || {};
  const m = s.mem || {};
  const total = m.MemTotal || 1, avail = m.MemAvailable || 0, used = total - avail;
  const pkgW = s.power_pkg || 0;
  return {
    host: { id: currentHost.id, name: currentHost.name, kind: 'remote' },
    ts: Date.now(),
    link: {
      ok: rOk, rtt: rRtt, bytes: rBytes, polls: polls, interval: cfg.intervalMs,
      host: currentHost.host + ':' + currentHost.port, mode: '远程 agent'
    },
    cpu: {
      cores: s.cores || [], count: (s.sys && s.sys.cores) || (s.cores || []).length,
      total: s.cpu_total || 0, user: s.cpu_user || 0, sys: s.cpu_sys || 0, iowait: s.cpu_iowait || 0,
      freq: s.freq || [], freqMax: (s.sys && s.sys.freqMaxMhz) || 0,
      coreTypes: [], pUsage: null, eUsage: null, freqP: null, freqE: null,
      load: s.load || [0, 0, 0], model: (s.sys && s.sys.model) || ''
    },
    mem: {
      total, avail, used, percent: used / total * 100,
      cached: (m.Cached || 0) + (m.SReclaimable || 0), buffers: m.Buffers || 0,
      shmem: m.Shmem || 0, anon: m.AnonPages || 0,
      swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
      style: 'linux'
    },
    disk: { devices: s.disk || [], totalR: s.disk_total_r || 0, totalW: s.disk_total_w || 0, volumes: (s.sys && s.sys.disks) || [] },
    net: { ifaces: (s.net || []).map(i => ({ name: i.name, rx: i.rx, tx: i.tx, rxTotal: i.rxTotal, txTotal: i.txTotal })) },
    gpu: null, batt: null,
    power: { pkg: pkgW, cores: s.power_cores || 0, ok: !!s.power_ok, temp: s.temp || {} },
    sys: s.sys || {},
    procs: {
      count: rProcs.count || 0,
      list: (rProcs.list || []).map(p => ({
        pid: p.pid, name: p.name, cpu: p.cpu, rss: p.rss, dr: p.dr, dw: p.dw,
        rx: p.nrx, tx: p.ntx, energy: pkgW * (p.cpu / 100)  // 真实封装功耗 × CPU 份额
      }))
    },
    docker: rDocker
  };
}

// ================================================================ 轮询调度
let timer = null;
async function poll() {
  if (!win || win.isDestroyed()) return;
  try {
    polls++;
    if (currentHost.kind === 'local') await pollLocal();
    else await pollRemote();
    win.webContents.send('stats', currentHost.kind === 'local' ? buildLocalPayload() : buildRemotePayload());
  } catch (e) { console.error('poll error', e); }
}
function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  timer = setInterval(poll, currentHost.kind === 'local' ? 2000 : cfg.intervalMs);
}

// ================================================================ 窗口
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 940, minHeight: 620,
    title: '任务管理器-统一版',
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // 调试：/tmp/tm_view 写主机 id 或页签名，启动直达
  win.webContents.on('did-finish-load', () => {
    try {
      if (fs.existsSync('/tmp/tm_view')) {
        const v = fs.readFileSync('/tmp/tm_view', 'utf8').trim();
        if (v) win.webContents.executeJavaScript(`try{window.__initView&&window.__initView(${JSON.stringify(v)})}catch(e){}`).catch(() => { });
      }
    } catch (e) { }
  });

  poll();
  schedule();
}

app.whenReady().then(async () => {
  staticInfo = await localStatic();
  // GPU 静态规格（system_profiler 较慢，异步取一次，不阻塞窗口）
  run('system_profiler SPDisplaysDataType 2>/dev/null', 15000).then(out => {
    const cores = (out.match(/Total Number of Cores:\s*(\d+)/) || [])[1];
    const metal = (out.match(/Metal Support:\s*(.+)/) || [])[1];
    staticInfo.gpu = { cores: cores ? parseInt(cores, 10) : null, metal: metal ? metal.trim() : null };
  });
  startNetStream();          // nettop 常驻流：每进程网络累计字节
  createWindow();
});

app.on('window-all-closed', () => { if (timer) clearInterval(timer); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ================================================================ IPC
ipcMain.on('set-view', (e, v) => {
  wantProcs = (v === 'procs');
  wantDocker = (v === 'docker');
  if ((wantProcs || wantDocker) && currentHost.kind === 'remote') poll();
});
ipcMain.on('set-interval', (e, ms) => {
  ms = parseInt(ms, 10);
  if ([2000, 5000, 10000].includes(ms)) { cfg.intervalMs = ms; saveCfg(cfg); schedule(); }
});
ipcMain.handle('get-hosts', () => ({ hosts: cfg.hosts, active: currentHost.id, intervalMs: cfg.intervalMs }));
ipcMain.handle('set-host', (e, id) => {
  const h = cfg.hosts.find(x => x.id === id);
  if (!h) return false;
  currentHost = h; cfg.activeHost = id; saveCfg(cfg);
  // 切换主机：重置远程缓存与流量计数，立即采一次
  rSnap = null; rProcs = { list: [], count: 0 }; rDocker = { containers: [] };
  rBytes = 0; rRtt = 0; rOk = false; rFail = 0; rLastProcFetch = 0; rLastDockerFetch = 0;
  // 同时重置本机侧差分基准：离开本机期间旧快照已过期，否则切回来首帧速率/进程 CPU 会失真
  lastIfaces = null; lastNetTime = 0; lastProcRaw = null; lastProcsTime = 0; lastCoreTicks = null;
  schedule();
  poll();
  return true;
});
ipcMain.handle('add-host', (e, h) => {
  try {
    const name = String(h.name || '').trim();
    const host = String(h.host || '').trim();
    const port = parseInt(h.port, 10) || 9100;
    if (!name || !host) return { ok: false, err: '名称和地址不能为空' };
    const id = 'r' + Date.now().toString(36);
    cfg.hosts.push({ id, name, kind: 'remote', host, port });
    saveCfg(cfg);
    return { ok: true, id };
  } catch (err) { return { ok: false, err: String(err) }; }
});
ipcMain.handle('remove-host', (e, id) => {
  if (id === 'local') return false;
  const wasActive = currentHost.id === id;
  cfg.hosts = cfg.hosts.filter(h => h.id !== id);
  if (wasActive) {
    currentHost = cfg.hosts[0];
    cfg.activeHost = currentHost.id;
    // 与 set-host 一致：清缓存 + 重排定时器，否则切回本机后仍按远程档位（如 10 秒）刷新
    rSnap = null; rProcs = { list: [], count: 0 }; rDocker = { containers: [] };
    rBytes = 0; rRtt = 0; rOk = false; rFail = 0; rLastProcFetch = 0; rLastDockerFetch = 0;
    lastIfaces = null; lastNetTime = 0; lastProcRaw = null; lastProcsTime = 0; lastCoreTicks = null;
    saveCfg(cfg);
    schedule();
    poll();
    return true;
  }
  saveCfg(cfg);
  return true;
});
ipcMain.handle('kill-process', async (e, pid) => {
  const isLocal = currentHost.kind === 'local';
  const where = isLocal ? '本机 Mac' : `${currentHost.name}（${currentHost.host}）`;
  // 远程也必须确认：远程结束进程之前没有任何提示，容易误杀生产容器里的进程
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['结束进程', '取消'], defaultId: 0, cancelId: 1,
    message: `确定要结束 ${where} 上的进程 ${pid} 吗？`,
    detail: isLocal ? '将发送 SIGKILL，未保存的数据可能会丢失。' : '将向远程 agent 发送 SIGTERM，未保存的数据可能会丢失。'
  });
  if (r.response !== 0) return '已取消';
  if (isLocal) {
    return new Promise((resolve) => {
      exec(`kill -9 ${pid}`, (err) => resolve(err ? '失败：' + err.message : `已结束进程 ${pid}`));
    });
  }
  const res = await postJSON('/api/kill', { pid, sig: 'TERM' });
  try {
    const j = JSON.parse(res.body || '{}');
    if (j.ok) return `已结束远程进程 ${pid}`;
    return '远程结束失败：' + (j.error || '未知错误');
  } catch (err) {
    return res.ok ? `已结束远程进程 ${pid}` : '远程结束失败';
  }
});
