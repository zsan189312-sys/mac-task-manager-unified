// Generated from desktop v2.2.7 collectors; no Electron, timers, nettop or UI lifecycle.
const {exec}=require('node:child_process');const path=require('node:path');
const KB=1024,MB=KB*1024,GB=MB*1024;
const appDir=process.env.TMU_APP_DIR||'/Applications/任务管理器-统一版.app/Contents/Resources/app';
const CPU_HELPER=path.join(appDir,'bin','cpucores'),PROCINFO=path.join(appDir,'bin','procinfo');
function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
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
  return { usage, user, sys, idle, coreLoads, pUsage, eUsage, loadAvg: require('os').loadavg() };
}

async function localMem() {
  const [vmStat, swap, pageCounts] = await Promise.all([
    run('vm_stat'),
    run('sysctl -n vm.swapusage'),
    run('sysctl -n vm.page_free_count vm.page_speculative_count vm.vm_page_external_count 2>/dev/null')
  ]);
  const page = 16384;
  const get = (name) => {
    const m = vmStat.match(new RegExp(name + ':\\s+(\\d+)'));
    return m ? parseInt(m[1], 10) * page : 0;
  };
  const free = get('Pages free'), active = get('Pages active'), inactive = get('Pages inactive');
  const wired = get('Pages wired down'), compressed = get('Pages occupied by compressor');
  const purgeable = get('Pages purgeable'), speculative = get('Pages speculative');
  const total = (staticInfo && staticInfo.memTotal) || 16 * GB;
  // 活动监视器口径（同时刻实测拟合，误差 ≤0.01GB）：
  //   已使用 = 总内存 − 空闲 − 投机(speculative) − 文件缓存(external file-backed)
  // 等价于「除空闲/预取/文件缓存外全部计入」。旧公式把 inactive 文件缓存全算已用，虚高 ~23 个百分点
  const pc = pageCounts.trim().split('\n').map(l => parseInt(l.trim(), 10) || 0);
  let used, fileCache;
  if (pc.length === 3 && pc.some(n => n > 0)) {
    fileCache = pc[2] * page;
    used = Math.min(total, Math.max(0, total - (pc[0] + pc[1] + pc[2]) * page));
  } else {
    // sysctl 不可用时的降级：近似（偏大）
    fileCache = Math.max(0, inactive - purgeable);
    used = Math.min(total, active + wired + compressed + fileCache);
  }
  const sm = swap.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/);
  return {
    total, used, avail: Math.max(0, total - used),
    active, wired, compressed, inactive, free, purgeable, speculative,
    fileCache,
    swapTotal: sm ? parseFloat(sm[1]) * MB : 0,
    swapUsed: sm ? parseFloat(sm[2]) * MB : 0
  };
}

async function localDiskIO() {
  const out = await run('iostat -c 2 -d disk0', 5000);
  const rows = out.trim().split('\n');
  // iostat -d 数据行固定 3 列：KB/t  tps  MB/s（此前误判 >=4 列导致解析恒为 0）
  // 取最后一行（第 2 个采样 = 最近 1 秒窗口；第 1 行是开机以来平均）
  let mbps = 0, tps = 0, kbt = 0;
  if (rows.length >= 3) {
    const cols = rows[rows.length - 1].trim().split(/\s+/);
    if (cols.length >= 3) {
      kbt = parseFloat(cols[0]) || 0;
      tps = parseFloat(cols[1]) || 0;
      mbps = parseFloat(cols[2]) || 0;
    }
  }
  return { mbps: mbps * MB, tps, kbt }; // macOS 的 iostat 不区分读/写，故按合计处理
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
    // ioreg 对负数（如放电电流）输出 64 位补码无符号形式（接近 2^64）。
    // 必须用 BigInt 解析：Number 在此量级（≥2^63）舍入步长为 2048，
    // parseInt 会把 -346 的补码舍入到恰好 2^64，减去 2^64 后得 0。
    let n = BigInt(m[1]);
    if (n > 9223372036854775807n) n -= 18446744073709551616n; // > 2^63-1 → 转有符号
    return Number(n);
  };
  const bool = (k) => new RegExp('"' + k + '"\\s*=\\s*Yes').test(io);
  const voltage = num('Voltage'), amperage = num('InstantAmperage');
  const external = bool('ExternalConnected'), isCharging = bool('IsCharging');
  const nom = num('NominalChargeCapacity'), des = num('DesignCapacity');
  // 健康度：优先取 macOS 官方评估（BatteryData.MaxCapacity，百分比），与系统设置「最大容量」口径一致；
  // 读不到时回退 标称满充容量/设计容量 的原始比值（更敏感，会略低于官方值）
  const bd = io.match(/"BatteryData"\s*=\s*\{[^}]*\}/);
  const bdMax = bd ? (bd[0].match(/"MaxCapacity"\s*=\s*(\d+)/) || [])[1] : null;
  const bdPct = bdMax ? parseInt(bdMax, 10) : 0;
  const health = (bdPct > 0 && bdPct <= 100) ? bdPct
    : (nom && des ? Math.round(nom / des * 1000) / 10 : null);
  return {
    percent: pct ? parseInt(pct, 10) : null,
    present: !!pct, external, charging: isCharging,
    status: !external ? 'discharging' : (isCharging ? 'charging' : 'external'),
    timeRemaining: time,
    voltage: voltage ? voltage / 1000 : null,
    amperage, watts: voltage && amperage ? (voltage * amperage) / 1e6 : null,
    nominal: nom,   // 标称满充容量 mAh，供渲染端估算「预计使用时间」（剩余mAh ÷ 当前电流）
    design: des,    // 设计出厂容量 mAh（电池容量 = 满充/设计）
    cycle: num('CycleCount'),
    health,
    // AdapterDetails 仅在接通电源时存在：Watts=充电器额定功率，AdapterVoltage=mV，Current=mA
    adapterWatts: (io.match(/"AdapterDetails"[^}]*?"Watts"\s*=\s*(\d+)/) || [])[1]
      ? parseInt(io.match(/"AdapterDetails"[^}]*?"Watts"\s*=\s*(\d+)/)[1], 10) : null,
    adapterVolt: (io.match(/"AdapterDetails"[^}]*?"AdapterVoltage"\s*=\s*(\d+)/) || [])[1]
      ? parseInt(io.match(/"AdapterDetails"[^}]*?"AdapterVoltage"\s*=\s*(\d+)/)[1], 10) / 1000 : null,
    // PowerTelemetryData.SystemPowerIn：整机从适配器实际取电功率（mW），含电池充电+系统负载+适配器损耗
    sysPowerIn: (io.match(/"SystemPowerIn"\s*=\s*(\d+)/) || [])[1]
      ? parseInt(io.match(/"SystemPowerIn"\s*=\s*(\d+)/)[1], 10) / 1000 : null
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


module.exports={init:async()=>{if(!require('node:fs').existsSync(CPU_HELPER)||!require('node:fs').existsSync(PROCINFO))throw new Error('缺少已安装桌面版的采集助手');if(!staticInfo)staticInfo=await localStatic();return staticInfo;},cpu:localCPU,memory:localMem,disk:localDiskIO,network:localNet,battery:localBattery,gpu:localGPU,processes:localProcs};
