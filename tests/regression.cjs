// Run production main-process logic in an isolated VM; no SSH, file mutation or process kill.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const code = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = value => JSON.parse(JSON.stringify(value));
const snap = (uptime = 100, cpuSec = 10) => ({sys:{cores:12,fcur:3600,perf:Object.fromEntries(Array.from({length:12},(_,i)=>['0,'+i,110+i]))},uptime,cores:Array(12).fill(10),mem:{total:100,avail:60},procs:[{pid:42,name:'test',cpuSec,rss:1}]});
const ok = data => ({ok:true,out:'<<<TMU>>>\n'+JSON.stringify(data),ms:10});
function harness({live = false} = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [], timers = [];
  const child = () => {
    const p = new EventEmitter();p.stdout=new EventEmitter();p.stdout.setEncoding=()=>{};p.stderr=new EventEmitter();p.stdin={end(){}};p.kill=()=>{};return p;
  };
  const cp = {spawn:(...args)=>{calls.push(['spawn',...args]);return live ? require('node:child_process').spawn(...args) : child();},exec:(...args)=>{calls.push(['exec',...args]);const cb=args.at(-1);if(typeof cb==='function')queueMicrotask(()=>cb(null,''));return child();},execFile:(...args)=>{calls.push(['execFile',...args]);const cb=args.at(-1);if(typeof cb==='function')queueMicrotask(()=>cb(null,''));return child();}};
  const dialog = {showMessageBox:async()=>({response:1}),showOpenDialog:async()=>({canceled:true}),showSaveDialog:async()=>({canceled:true})};
  const cfg = {hosts:[{id:'local',kind:'local',name:'MacBook'},{id:'n100',kind:'remote',name:'N100',host:'n100',port:9100},{id:'win11',kind:'win',name:'Win11',host:'win11'}],activeHost:'win11',intervalMs:2000};
  const electron={app:{disableHardwareAcceleration(){},setName(){},getPath:()=>'/isolated-test',requestSingleInstanceLock:()=>true,whenReady:()=>({then(){}}),on(){},quit(){}},BrowserWindow:{getAllWindows:()=>[]},ipcMain:{handle:(k,v)=>handlers.set(k,v),on:(k,v)=>listeners.set(k,v)},dialog,nativeTheme:{}};
  const ctx=vm.createContext({__dirname:path.join(__dirname,"../app"),console,Buffer,process,require:n=>n==='electron'?electron:n==='child_process'?cp:n==='fs'?{...fs,readFileSync:(p,...a)=>p==='/isolated-test/config.json'?JSON.stringify(cfg):fs.readFileSync(p,...a),writeFileSync:(p,...a)=>{if(p!=='/isolated-test/config.json')fs.writeFileSync(p,...a)},existsSync:p=>live?fs.existsSync(p):false}:require(n),setTimeout:(fn,ms)=>{if(live)return setTimeout(fn,ms);timers.push({fn,ms});if(ms<1000)queueMicrotask(fn);return fn;},clearTimeout:id=>{if(live)clearTimeout(id)},setInterval:fn=>live?setInterval(fn,400):fn,clearInterval:id=>{if(live)clearInterval(id)},queueMicrotask});
  vm.runInContext(code+`\nwin={isDestroyed:()=>false,webContents:{send:(...a)=>globalThis.frames.push(a)}};`,ctx);
  ctx.frames=[];
  return {ctx,handlers,listeners,calls,timers,dialog,run:s=>vm.runInContext(s,ctx),ssh:fn=>{ctx.mockSSH=fn;vm.runInContext('sshWin=mockSSH',ctx);}};
}
test('JSON protocol parses arrays/null and ignores pre-marker noise',()=>{
 const h=harness();assert.deepEqual(plain(h.run(`parseWinJson('noise\\n<<<TMU>>>\\n[1,2]')`)),[1,2]);assert.equal(h.run(`parseWinJson('<<<TMU>>>\\nnull')`),null);
});
test('Windows first failed sample invalidates old telemetry immediately',async()=>{
 const h=harness();h.ctx.seed=snap();h.run('wSnap=seed;wOk=true;wGpu={util:99,power:100};wSensors=[{val:4500}];');h.ssh(async()=>({ok:false,out:'',ms:1}));await h.run('pollWindows()');assert.equal(h.run('wOk'),false);assert.equal(h.run('wSnap'),null);assert.equal(h.run('wGpu'),null);assert.equal(h.run('wSensors'),null);
});
test('GPU/sensor sub-sample failure clears stale optional values',async()=>{
 const h=harness();h.run('wGpu={util:99};wSensors=[{val:4500}];');h.ssh(async(_,s)=>s.includes('Win32_OperatingSystem')?ok(snap()):s.includes('nvidia-smi')?ok(null):({ok:true,out:'[]',ms:1}));await h.run('pollWindows()');assert.equal(h.run('wGpu'),null);assert.equal(h.run('wSensors'),null);
});
test('In-flight Windows sample cannot repopulate a different host cache',async()=>{
 const h=harness();let resolve;const result=new Promise(r=>resolve=r);h.ssh(()=>result);const pending=h.run('pollWindows()');await Promise.resolve();h.run(`currentHost=cfg.hosts[1];if(typeof hostEpoch!=='undefined')hostEpoch++;`);resolve(ok(snap()));await pending;assert.equal(h.run('wSnap'),null);
});
test('Rebooted uptime resets process CPU baseline before PID reuse',async()=>{
 const h=harness();h.ctx.seed=snap(5000,100);h.run('wSnap=seed;wPrevProcs={42:100};wPrevTime=Date.now()-1000;');h.ssh(async(_,s)=>s.includes('Win32_OperatingSystem')?ok(snap(10,500)):({ok:false,out:''}));await h.run('pollWindows()');assert.equal(h.run('buildWinPayload().procs.list[0].cpu'),0);
});
test('Switching to Windows triggers an immediate remote poll',async()=>{
 const h=harness();h.run('globalThis.remoteCalls=0;globalThis.localCalls=0;poll=()=>remoteCalls++;sampleLocal=()=>localCalls++;');await h.handlers.get('set-host')({},'win11');assert.equal(h.ctx.remoteCalls,1);assert.equal(h.ctx.localCalls,0);
});
test('Process kill confirmation is cancelled if target host changed',async()=>{
 const h=harness();let resolve;h.dialog.showMessageBox=()=>new Promise(r=>resolve=r);const task=h.handlers.get('kill-process')({},42);h.run("currentHost=cfg.hosts[1];if(typeof hostEpoch!=='undefined')hostEpoch++;");resolve({response:0});const msg=await task;assert.match(msg,/切换|取消/);assert.equal(h.calls.length,0);
});
test('Process PID rejects trailing garbage',async()=>{
 const h=harness();let prompts=0;h.dialog.showMessageBox=async()=>{prompts++;return{response:1}};assert.match(await h.handlers.get('kill-process')({},'42garbage'),/无效/);assert.equal(prompts,0);
});
test('Win copy refuses overwrite and recursive copy into itself',()=>{
 const h=harness();const script=h.run(`winOpScript('copy','C:\\\\src','C:\\\\dst')`);assert.match(script,/Test-Path/);assert.doesNotMatch(script,/Copy-Item[^\n]*-Force/);
});
test('SFTP quotes preserve literal quotes/backslashes and reject newlines',()=>{
 const h=harness();assert.equal(h.run(`sftpQuote('a"b\\\\c')`),'"a\\"b\\\\c"');assert.throws(()=>h.run(`sftpQuote('a\\nb')`));
});
test('Sensor Infinity/NaN never becomes power telemetry',()=>{
 const h=harness();h.ctx.seed=snap();h.run(`wSnap=seed;wSensors=[{hw:'Cpu',type:'Power',name:'Package',val:Infinity}];`);assert.equal(h.run('buildWinPayload().power'),null);
});
test('Dynamic frequency mapping and per-core LHM fallback',()=>{
 const h=harness();h.ctx.seed=snap();h.run(`wSnap=seed;wSensors=[{hw:'Cpu',type:'Clock',name:'Core #2',val:4200}];`);const cpu=plain(h.run('buildWinPayload().cpu'));assert.equal(cpu.freq[0],3960);assert.equal(cpu.freq[1],4200);assert.equal(cpu.freq[7],4200);assert.equal(cpu.freq[10],4320);assert.equal(cpu.freqMax,4356);
});

test('LHM nonstandard NaN preserves valid sensor records',()=>{
 const h=harness();const data=plain(h.run(`parseSensorJson('[{"val":NaN,"name":"Core #1"},{"val":51.5,"name":"CPU Tctl"}]')`));assert.equal(data[0].val,null);assert.equal(data[1].val,51.5);
});
test('A-B-A host generation drops late results even with same host object',async()=>{
 const h=harness();let resolve;const pending=new Promise(r=>resolve=r);h.ssh(()=>pending);const task=h.run('pollWindows()');await Promise.resolve();h.run('hostEpoch+=2;');resolve(ok(snap()));await task;assert.equal(h.run('wSnap'),null);
});
test('Linux unavailable snapshot clears stale processes and metrics',async()=>{
 const h=harness();h.run("currentHost=cfg.hosts[1];rOk=true;rSnap={cpu_total:90};rProcs={list:[{pid:42}],count:1};getJSON=async()=>({ok:false});");await h.run('pollRemote()');assert.equal(h.run('rOk'),false);assert.equal(h.run('rSnap'),null);assert.equal(h.run('rProcs.count'),0);
});
test('Linux in-flight snapshot cannot write after host switch',async()=>{
 const h=harness();h.run('currentHost=cfg.hosts[1]');let resolve;h.ctx.request=new Promise(r=>resolve=r);h.run('getJSON=()=>request');const task=h.run('pollRemote()');h.run('currentHost=cfg.hosts[2];hostEpoch++');resolve({ok:true,data:{sys:{},cores:[1],mem:{}}});await task;assert.equal(h.run('rSnap'),null);
});
const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
function rendererHarness() {
 const elements=new Map(),callbacks={};
 const context=new Proxy({},{get:()=>()=>{}});
 const element=id=>{if(!elements.has(id))elements.set(id,{style:{},dataset:{},classList:{toggle(){},add(){},remove(){}},innerHTML:'',textContent:'',children:[],appendChild(){},querySelectorAll:()=>[],addEventListener(){},getContext:()=>context,getBoundingClientRect:()=>({width:500,height:200}),focus(){},select(){}});return elements.get(id)};
 const window={devicePixelRatio:1,events:{},addEventListener:(k,v)=>{window.events[k]=v},bridge:{onStats:fn=>callbacks.stats=fn,onLocalHist(){},onSamplingGap:fn=>callbacks.gap=fn,onDlProgress(){},getHosts:async()=>({hosts:[],active:'win11',intervalMs:2000}),setView(){}}};
 const document={getElementById:element,querySelectorAll:()=>[],createElement:()=>element('created'+Math.random()),body:element('body')};
 const ctx=vm.createContext({window,document,console,setTimeout,clearTimeout,innerWidth:1000,innerHeight:800,navigator:{clipboard:{writeText(){}}}});
 const source=renderer.replace(/renderHostSeg\(\);\s*buildSidebar\(\);\s*switchView\('perf'\);\s*$/,'');
 vm.runInContext(source,ctx);
 return {ctx,window,elements,callbacks,run:s=>vm.runInContext(s,ctx)};
}
test('Offline renderer shows retry overlay and adds a gap, not stale samples',()=>{
 const h=rendererHarness();h.run("hist.cpu=[20,30];histHostId='win11';currentHostId='win11';");h.callbacks.stats({host:{id:'win11',kind:'win',name:'Win11'},link:{ok:false},cpu:{total:99}});assert.deepEqual(plain(h.run('hist.cpu')),[20,30,null]);assert.equal(h.elements.get('connection-hint').style.display,'flex');h.callbacks.stats({host:{id:'win11',kind:'win',name:'Win11'},link:{ok:false},cpu:{total:99}});assert.equal(h.run('hist.cpu.length'),3);
});
test('Out-of-order directory response never replaces newer directory',async()=>{
 const h=rendererHarness();h.run("latest={host:{id:'win11',kind:'win'}};currentView='files';");let a,b;h.window.bridge.listWinDir=p=>new Promise(r=>{if(p==='C:\\a')a=r;else b=r});const pa=h.run("openDir('C:\\\\a')");const pb=h.run("openDir('C:\\\\b')");b({ok:true,items:[]});await pb;a({ok:true,items:[{n:'old'}]});await pa;assert.equal(h.run('filesPath'),'C:\\b');assert.equal(h.run('filesItems.length'),0);
});
test('Failed cut/paste keeps clipboard for retry',async()=>{
 const h=rendererHarness();h.run("filesPath='C:\\\\dst';currentView='files';fileClip={op:'cut',path:'C:\\\\src\\\\file.txt'};");h.window.bridge.fileOp=async()=>({ok:false,err:'offline'});await h.run("pasteClip('C:\\\\dst')");assert.equal(h.run('fileClip.op'),'cut');
});
test('Windows filename validator rejects device names and trailing dot',()=>{
 const h=rendererHarness();for(const name of ['CON','nul.txt','LPT1.log','..','file.','a/b']){h.ctx.value=name;assert.notEqual(h.run('winNameError(value)'),'',name)}assert.equal(h.run("winNameError('测试文件 [1].txt')"),'');
});
test('Both network graph series share the same scale',()=>{
 const h=rendererHarness();h.run('globalThis.scales=[];strokeSeries=(a,b,c,d,e,max)=>scales.push(max);');h.ctx.canvas=h.elements.get('bigchart')||{getContext:()=>({setTransform(){},clearRect(){}}),getBoundingClientRect:()=>({width:300,height:100})};h.run("drawOverlaid(canvas,[1,2],[100,200],'#fff','#000')");assert.equal(h.run('scales.length'),2);assert.equal(h.run('scales[0]'),h.run('scales[1]'));
});


test('Unavailable zero CPU power and temperature are not shown as real readings',()=>{
 const h=harness();h.ctx.seed=snap();h.run("wSnap=seed;wGpu={power:100};wSensors=[{hw:'Cpu',type:'Power',name:'Package',val:0},{hw:'Cpu',type:'Temperature',name:'Core (Tctl/Tdie)',val:0}];");const power=plain(h.run('buildWinPayload().power'));assert.equal(power.cpu,null);assert.equal(power.cpuTemp,null);assert.equal(power.pkg,100);assert.equal(power.partial,true);
});
test('Nettop uses streaming spawn rather than exec output accumulation',()=>{
 const h=harness();h.run('currentHost=cfg.hosts[0];wantProcs=true;startNetStream()');assert.equal(h.calls[0][0],'spawn');assert.equal(h.calls[0][1],'nettop');assert.equal(h.calls.some(x=>x[0]==='exec'),false);assert.equal(h.calls[0][3].stdio[0],'pipe');assert(h.calls[0][2].includes('-c'));assert(h.calls[0][2].includes('-s'));
});
test('Real HTTP 500 and aborted bodies do not count as successful telemetry',async()=>{
 const http=require('http');let mode='error';const server=http.createServer((req,res)=>{if(mode==='error'){res.writeHead(500);res.end('{"sys":{},"cores":[1],"mem":{}}')}else{res.writeHead(200,{'Content-Length':'1000'});res.write('{');setImmediate(()=>res.destroy());}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const h=harness();h.ctx.port=server.address().port;h.run("currentHost={id:'test',kind:'remote',host:'127.0.0.1',port};");assert.equal((await h.run("getJSON('/api/snapshot')")).ok,false);mode='aborted';assert.equal((await h.run("getJSON('/api/snapshot')")).ok,false);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});


test('Sidebar card changes keep the latest values immediately',()=>{
 const h=rendererHarness();h.ctx.payload={host:{kind:'win'},cpu:{total:42,count:12},mem:{total:100,used:40},disk:{totalR:0,totalW:0},net:{ifaces:[]}};h.run('buildSidebarFor(payload)');assert.equal(h.elements.get('sub-cpu').textContent,'42% · 12 核');
});
test('Escape closes the file context menu',()=>{
 const h=rendererHarness();h.run("ctxMenu.style.display='block'");h.window.events.keydown({key:'Escape',metaKey:false});assert.equal(h.run('ctxMenu.style.display'),'none');
});

test('Windows CPU model uses the processor name, not the motherboard',()=>{const h=harness();h.ctx.seed=snap();h.run("wSnap=seed;wSnap.sys.cpuModel='AMD Ryzen 5 3600';wSnap.sys.model='ASUS System Product Name';");assert.equal(h.run('buildWinPayload().cpu.model'),'AMD Ryzen 5 3600');});


test('Missing power-chart temperature is a gap, never a fabricated zero',()=>{
 const h=rendererHarness();h.run("currentHostId='win11';histHostId='win11';buildSidebarFor=()=>{};updateSidebar=()=>{};tickDetail=()=>{};");
 const payload={host:{id:'win11',kind:'win',name:'Win11'},link:{ok:true,interval:2000,rtt:1,bytes:0},cpu:{total:10,cores:[],model:'Ryzen'},mem:{percent:50},disk:{totalR:0,totalW:0},net:{ifaces:[]},power:{pkg:120,ok:true},sys:{uptime:10},procs:{count:0,list:[]}};
 h.callbacks.stats(payload);assert.equal(h.run('hist.temp[0]'),null);
 payload.power.temp={x86_pkg_temp:50};h.callbacks.stats(payload);assert.equal(h.run('hist.temp[1]'),50);
});


test('PawnIO real sensor fixture supplies CPU power, temperature and LHM clocks',()=>{
 const h=harness();h.ctx.seed=snap();h.ctx.sensors=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/lhm-pawnio-cpu.json'),'utf8'));
 h.run('wSnap=seed;wSensors=sensors;wGpu={power:100,util:50};');const data=plain(h.run('buildWinPayload()'));
 assert.equal(data.power.cpu,36.404);assert.equal(data.power.cpuTemp,62.125);assert(Math.abs(data.power.pkg-136.404)<1e-6);assert.equal(data.power.partial,false);assert(data.cpu.freqSources.every(x=>x==='lhm'));
});
test('Windows power chart uses real CPU temperature and preserves missing values',()=>{
 const h=rendererHarness();h.ctx.data={power:{style:'win',cpuTemp:62.875}};assert.equal(h.run('pkgTemp(data)'),'62.9');h.ctx.data.power.cpuTemp=null;assert.equal(h.run('pkgTemp(data)'),'—');h.ctx.data.power.cpuTemp=0;assert.equal(h.run('pkgTemp(data)'),'—');
});


test('Nettop is absent outside local process view and stops without retry',()=>{
 const h=harness();h.run('startNetStream()');assert.equal(h.calls.length,0);
 h.run('currentHost=cfg.hosts[0];wantProcs=true;updateNetStream()');assert.equal(h.calls.length,1);
 const child=h.run('netStream');let killed=false;child.kill=()=>{killed=true;child.emit('close',0)};
 h.run('wantProcs=false;updateNetStream()');assert(killed);assert.equal(h.run('netStream'),null);assert.equal(h.timers.length,0);
});
test('Local process enumeration is skipped outside process page',async()=>{
 const h=harness();h.run('currentHost=cfg.hosts[0];globalThis.processReads=0;localProcs=async()=>{processReads++;return {count:1,list:[]}}');
 await h.run('pollLocal()');await h.run('pollLocal()');await h.run('pollLocal()');assert.equal(h.ctx.processReads,0);
 h.run('wantProcs=true;lRefreshUI=true;');await h.run('pollLocal()');assert.equal(h.ctx.processReads,1);
});
test('Windows process flag gates expensive queries but retains live count',async()=>{
 const h=harness();let flags=[];h.ssh(async(_,s)=>{if(s.includes('Win32_OperatingSystem')){flags.push(s.includes('if(1){$pr'));return ok({...snap(),processCount:350,procs:[]})}return {ok:false,out:''}});
 await h.run('pollWindows()');assert.equal(h.run('buildWinPayload().procs.count'),350);assert.equal(h.run('buildWinPayload().procs.list.length'),0);
 h.run('wantProcs=true;');await h.run('pollWindows()');assert.deepEqual(flags,[false,true]);
 for(const v of ['0','1']){const enc=Buffer.from(h.run('WIN_PS').replace('__PROCS__',v),'utf16le').toString('base64');assert(enc.length<8191);assert(('powershell -NoProfile -NonInteractive -EncodedCommand '+enc).length<8191);}
});
test('Sensor HTTP uses direct SSH curl without starting PowerShell',async()=>{
 const h=harness();const args=[];h.ssh(async(...a)=>{args.push(a);return a[1].includes('Win32_OperatingSystem')?ok(snap()):{ok:false,out:''}});await h.run('pollWindows()');assert.equal(args.find(a=>a[1].includes('curl.exe'))[4],true);
});
test('Pause reasons overlap and resume only after the last reason clears',async()=>{
 const h=harness();h.run('globalThis.localCalls=0;globalThis.remoteCalls=0;sampleLocal=()=>localCalls++;poll=()=>remoteCalls++;');
 h.run("setSamplingPaused('minimized',true);setSamplingPaused('locked',true);setSamplingPaused('minimized',false)");assert(h.run('samplingPaused'));assert.equal(h.ctx.localCalls,0);
 h.run("setSamplingPaused('locked',false)");assert.equal(h.run('samplingPaused'),false);assert.equal(h.ctx.localCalls,1);assert.equal(h.ctx.remoteCalls,1);assert.equal(h.ctx.frames[0][0],'sampling-gap');
});
test('Paused collectors do not start any new work',async()=>{
 const h=harness();h.run("setSamplingPaused('hidden',true)");await h.run('sampleLocal()');await h.run('poll()');assert.equal(h.calls.length,0);assert.equal(h.ctx.frames.length,0);
});
test('A remote sample finishing after minimize is never rendered',async()=>{
 const h=harness();let finish;h.ctx.pending=new Promise(r=>finish=r);h.run('pollWindows=()=>pending');const task=h.run('poll()');h.run("setSamplingPaused('minimized',true)");finish();await task;assert.equal(h.ctx.frames.length,0);
});
test('A local sample finishing after minimize is never rendered',async()=>{
 const h=harness();let finish;h.ctx.pending=new Promise(r=>finish=r);h.run('pollLocal=()=>pending');const task=h.run('sampleLocal()');h.run("setSamplingPaused('minimized',true)");finish();await task;assert.equal(h.ctx.frames.length,0);
});
test('Resume puts a gap into history instead of replaying old values',()=>{
 const h=rendererHarness();h.run('push(hist.cpu,30);histCache.local=newHist();push(histCache.local.cpu,40)');h.callbacks.gap();assert.equal(h.run('hist.cpu.at(-1)'),null);assert.equal(h.run('histCache.local.cpu.at(-1)'),null);
});

test('A Windows response spanning pause and resume cannot refill the cache',async()=>{
 const h=harness();let finish;const pending=new Promise(r=>finish=r);h.ssh(()=>pending);const task=h.run('pollWindows()');await Promise.resolve();h.run("sampleLocal=()=>{};poll=()=>{};setSamplingPaused('minimized',true);setSamplingPaused('minimized',false)");finish(ok(snap()));await task;assert.equal(h.run('wSnap'),null);
});

test('Startup detects a locked macOS console even when Electron reports idle',()=>{
 const h=harness();assert.equal(h.run(`sessionIsLocked('idle','[{"kCGSSessionOnConsoleKey":true,"CGSSessionScreenIsLocked":true}]')`),true);
 assert.equal(h.run(`sessionIsLocked('locked','')`),true);
});
test('An inactive locked user cannot pause the active unlocked console',()=>{
 const h=harness();assert.equal(h.run(`sessionIsLocked('idle','[{"kCGSSessionOnConsoleKey":false,"CGSSessionScreenIsLocked":true},{"kCGSSessionOnConsoleKey":true,"CGSSessionScreenIsLocked":false}]')`),false);
 assert.equal(h.run(`sessionIsLocked('idle','invalid')`),false);
});

module.exports={harness,snap,ok,rendererHarness};
if(require.main===module)(async()=>{let failed=0;for(const {name,fn} of tests){try{await fn();console.log('PASS '+name)}catch(e){failed++;console.log('FAIL '+name+' :: '+e.message)}}console.log(`${tests.length-failed}/${tests.length} passed`);process.exitCode=failed?1:0;})();
