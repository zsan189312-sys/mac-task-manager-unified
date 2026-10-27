#!/usr/bin/env python3
"""Explicit on-demand launcher; never registers a login item or LaunchAgent."""
from pathlib import Path
import sys,os,json,subprocess,shutil,signal,urllib.request
root=Path(__file__).resolve().parent
private=Path.home()/'Library/Application Support/TMU-Mobile'
cfgfile=private/'mac.json';pidfile=private/'mac-probe.pid';logfile=private/'mac-probe.log'
if not cfgfile.exists():raise SystemExit('缺少私有连接配置，请先完成本机配置。')
cfg=json.loads(cfgfile.read_text());action=sys.argv[1] if len(sys.argv)>1 else 'start'
def online():
    try:
        req=urllib.request.Request(f'http://{cfg["bind"]}:{cfg["port"]}/v1/health',headers={'Authorization':'Bearer '+cfg['token']})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req,timeout=2) as r:return json.load(r).get('readOnly') is True
    except Exception:return False
if action=='status':print('采集端在线' if online() else '采集端未运行');raise SystemExit(0)
if action=='stop':
    if pidfile.exists():
        pid=int(pidfile.read_text());p=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True)
        if str(root/'probe.cjs') in p.stdout:
            os.kill(pid,signal.SIGTERM);print('已停止本机采集端')
        else:print('记录进程已退出，未停止其他程序')
        pidfile.unlink(missing_ok=True)
    else:print('没有本机采集端进程记录')
    raise SystemExit(0)
if online():print('本机采集端已运行，复用现有实例。');raise SystemExit(0)
node=shutil.which('node') or '/opt/homebrew/bin/node'
with logfile.open('ab') as log:
    p=subprocess.Popen([node,str(root/'probe.cjs'),str(cfgfile)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
pidfile.write_text(str(p.pid));pidfile.chmod(0o600)
print('本机采集端已启动；仅手机查看时采样，闲置 20 分钟自动退出。')
