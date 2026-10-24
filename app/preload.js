const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  onStats: (cb) => ipcRenderer.on('stats', (e, data) => cb(data)),
  // 本机后台常驻采样帧（看远程主机时喂本机曲线缓存，纯本地零流量）
  onLocalHist: (cb) => ipcRenderer.on('local-hist', (e, data) => cb(data)),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  // 告诉主进程当前在看哪个页签（远程主机按需采集，省流量）
  setView: (v) => ipcRenderer.send('set-view', v),
  // 远程轮询间隔（毫秒）：2000 / 5000 / 10000
  setInterval: (ms) => ipcRenderer.send('set-interval', ms),
  getHosts: () => ipcRenderer.invoke('get-hosts'),
  setHost: (id) => ipcRenderer.invoke('set-host', id),
  addHost: (h) => ipcRenderer.invoke('add-host', h),
  removeHost: (id) => ipcRenderer.invoke('remove-host', id),
  // v2.1.0：Win11 文件浏览 + 下载到 Mac
  listWinDir: (p) => ipcRenderer.invoke('win-list-dir', p),
  downloadWin: (path, isDir, size) => ipcRenderer.invoke('win-download', { path, isDir, size }),
  onDlProgress: (cb) => ipcRenderer.on('dl-progress', (e, d) => cb(d)),
  // v2.2.0：右键菜单文件操作 + 上传
  fileOp: (op, a, b) => ipcRenderer.invoke('win-file-op', { op, a, b }),
  uploadWin: (dir) => ipcRenderer.invoke('win-upload', { dir }),
  confirmDialog: (title, message, detail) => ipcRenderer.invoke('confirm-dialog', { title, message, detail })
});
