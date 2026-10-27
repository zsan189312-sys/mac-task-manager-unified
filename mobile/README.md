# 三端任务管理器 · Android 1.0.2

原生 Java Android App，target/compile SDK 36（Android 16），最低 Android 9。第一版只读监控和进程列表，无文件管理、结束进程或后台常驻服务。

- 总览同时显示 MacBook、N100、Win11；点击卡片查看逐核 CPU、内存、网络、磁盘、GPU、电池及硬件可提供的温度/功耗。
- 进程列表按整机 CPU 占比排序，支持名称和 PID 搜索、三主机切换；最多返回前 100 个进程并显示真实总数。
- 5/10/30 秒刷新，离开前台停止请求和绘制；仅新采样到达时播放 650ms、约 30fps 的圆环、内存条与曲线末段动画，不使用 WebView。离线/缺失读数显示缺失，不加入模拟数据。
- 连接口令通过 Android Keystore AES-GCM 加密保存，关闭系统备份；APK 中不包含设备私钥或连接口令。HTTP 只允许 Tailscale 地址/回环地址，手机访问 Tailscale HTTP 端点时检查 VPN；HTTPS 使用系统证书校验。

## 架构与使用条件

```text
Android 前台查看 → Tailscale → N100 只读网关 :19100
                                  ├─ 原 n100-agent :9100
                                  ├─ Mac 按需探针 :19101
                                  └─ Win11 只读导出器 :19101 → 原 LHM/PawnIO :8086
```

采集中心长期运行于 N100，由 systemd 托管；它只在客户端请求时读取上游，缓存 4.5–5 秒并合并并发。不会反复启动 SSH/PowerShell，也不复制现有 SSH 私钥。三个设备的失败互相隔离；缺失/过期响应不保留为实时值。既有 N100 agent 与 macOS Electron v2.2.7 不做修改。

Mac 私有地址健康检查直接连接，不经过本机全局 HTTP 代理，避免误报/重复启动。

Mac 不是长期服务部署环境。本机探针无开机自启、无后台轮询；查看前双击 `mac/启动Mac采集端.command`，闲置 20 分钟退出，也可双击停止脚本。Mac 必须保持开机联网，睡眠时不可采集。仅复用已安装桌面版中的只读 Swift 助手和系统命令；不需要桌面窗口一直打开，不开放 Mac SSH。

Windows 导出器同样只读、按请求采集，监听自己的 Tailscale 地址；防火墙仅允许 N100 的 Tailscale IP。原传感器脚本和任务不改动，仍为登录触发。Windows 需开机、联网并登录原用户才能保证传感器启动。

## 当前交付边界（2026-10-27）

- 已在 vivo V2417A / Android 16（API 36）安装并通过 Tailscale 直接连接，无 USB 网络转发。连接文件导入后使用 Keystore 保存，升级保留连接配置。
- 总览使用蓝/绿/紫三张原生绘制卡片；显示源采样时间、CPU 圆环、内存条、温度、网络和功耗。数字直接显示实测值，只有图形短暂过渡；曲线缺失处断开、不制造波动，遵守系统关闭动画设置。内存与速率按 GiB / MiB / KiB 标明二进制口径。
- N100 网关已部署；Mac/N100 的手机读数按相同采样时间与网关原值核对。N100 当前通过 wlo1 无线接口，已修复漏选该接口导致速度为零；总内存取源数据约 7.5 GiB，不沿用旧 16GB。
- 已验证详情、进程搜索/主机切换、Android 返回手势、断线自动恢复、后台停止请求/绘制和回前台恢复。网络失败会清空旧进程，不把上一台主机或旧读数当作当前数据；缓存每次返回都重算年龄，超过 30 秒隐藏。
- **Windows 仍因用户设备无法开机而待部署/联调**：新的 Windows 导出器尚未安装，网关 Windows URL 为未启用，界面如实显示采集端未配置。不能称三台端到端均已验收。开机后需完成下方部署步骤。
- 1.0.1 是本轮内部测试构建（断线/切换/返回兼容性），未独立发布；1.0.2 汇总修复与总览动效。仅该真机 Android 16 已实测，最低版本声明不代表所有机型已测试。

## 构建和验证

安装官方 SDK `platforms;android-36` / `build-tools;36.0.0`，使用 JDK 17：

```sh
python3 mobile/android/build.py
node --test mobile/tests/*.test.cjs
```

构建使用官方 aapt2 → javac → D8 → zipalign → apksigner，无 Gradle 常驻进程。APK 在 `mobile/android/build/TaskManager-Mobile-v1.0.2.apk`。签名私钥与口令只保存在本机 `Library/Application Support/TMU-Mobile/signing/`，不要提交或上传，后续升级必须沿用。

`tests/EndpointTest.java` 可与 `android/src/com/tmu/mobile/Endpoint.java` 在普通 JDK 编译运行，检查端点规则；这不是 Android 运行测试。

## 私有配置与配对

私有配置保存在 Mac `Library/Application Support/TMU-Mobile/`，权限 0600；本仓库不存凭据：

- `gateway.json`：N100 网关配置和三个上游，网关口令与探针口令不同。
- `mac.json` / `windows.json`：各主机自己的监听地址、端口和独立口令。
- `pairing.json`：只有 Android 所需的 `gateway` 和只读 `token`。在手机设置页选择“导入连接文件”；不要将此文件上传到公开 Release 或聊天。

网关配置结构示意（值均为占位符；生成至少 32 字符随机口令）：

```json
{
  "bind": "100.64.0.2", "port": 19100, "token": "REPLACE_WITH_RANDOM_GATEWAY_TOKEN",
  "n100": {"url": "http://100.64.0.2:9100"},
  "mac": {"url": "http://100.64.0.3:19101", "token": "REPLACE_WITH_RANDOM_MAC_TOKEN"},
  "win11": {"url": null, "token": "REPLACE_WITH_RANDOM_WINDOWS_TOKEN"}
}
```

手机连接同一 Tailscale 网络；需要手工配置时，网关地址与只读口令在设置页输入，其他页面不显示口令。

## N100 运维

当前源码部署于 `/home/xx/services/tmu-mobile/server`；私有配置 `/home/xx/.config/tmu-mobile/gateway.json`；systemd 单元 `tmu-mobile.service`。使用普通用户运行，限制地址族、禁止提权、只读文件系统、内存限额 192 MiB、CPU 限额单核 15%；状态/日志：

```sh
ssh n100 'systemctl status tmu-mobile.service --no-pager'
ssh n100 'journalctl -u tmu-mobile.service -n 30 --no-pager'
```

HTTP API 都要求 `Authorization: Bearer <private-token>`：`GET /v1/health`、`GET /v1/overview`、`GET /v1/processes?host=mac|n100|win11`。拒绝未授权、未知主机和所有写操作。只绑定 Tailscale 地址，不对公网做端口映射。

## Windows 后续部署（本轮未执行）

1. Win11 开机、联网并登录既有用户，检查 `ssh win11` 与原 `127.0.0.1:8086/health`。
2. 用 SFTP `/C:/...` 路径将 `windows/*.ps1` 与独立私有 `windows.json` 放入选定目录；先做 PowerShell Parser 检查，备份已有同名文件。不要覆盖原传感器脚本或复制 Mac SSH 私钥。
3. 在原用户管理员会话运行 `install.ps1 -Config <private-windows.json> -GatewayIP <N100-Tailscale-IP>`。脚本只新建 `TMU-MobileExporter` 登录任务及仅允许 N100 的入站规则；遇到已有同名任务会拒绝覆盖。
4. 验证授权/未授权读取、温度/功耗/动态频率、进程差分、服务恢复，再将网关 `win11.url` 改为该 Tailscale 地址的 `http://...:19101` 并重启网关。
5. 回滚时停止并移除新任务及其专用防火墙规则，网关 `win11.url` 设回 null；原 LHM/PawnIO 任务保持原样。不要重启整机或降低系统安全保护。

## 源码版本

本目录独立版本 1.0.2，Git tag `android-v1.0.2`。桌面版继续 v2.2.7，其部署、签名和启动铁律不变。Mac 采集函数来自桌面 v2.2.7 的已验逻辑（`mac/desktop-collectors.cjs`），不包含 Electron 生命周期、计时轮询或 nettop；Windows 固定采集脚本同样来自该版，走文件执行以避免 Windows 编码命令长度限制。
