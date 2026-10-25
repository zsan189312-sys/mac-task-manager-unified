# Windows 传感器链路

任务管理器通过 SSH 读取 Windows 自身 `http://127.0.0.1:8086/` 的 JSON 数组。服务只启用 LHM 的 CPU 采集，GPU 由客户端 nvidia-smi 独立读取。收到 GET / 或 /health 时更新，1 秒内重复请求复用缓存，无请求时阻塞等待、不采样；`/health` 提供库版本、采样时间、有效 CPU 温度/功耗与错误状态。

2026-10-25 已迁移：LibreHardwareMonitor 0.9.6（.NET Framework 包）+ 官方签名 PawnIO 2.2.0。Windows PowerShell 5.1 使用标准 `LibreHardwareMonitor.zip`，不是 .NET 10 包。原任务仍是登录触发，最高权限；未验证未登录启动或实际系统重启。

## 官方文件与核验

- [LHM v0.9.6](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/tag/v0.9.6)，`LibreHardwareMonitor.zip` SHA256 `086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001`。
- [PawnIO 2.2.0](https://github.com/namazso/PawnIO.Setup/releases/tag/2.2.0)，`PawnIO_setup.exe` SHA256 `1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032`。
- 核验下载哈希与 `Get-AuthenticodeSignature` 后，在管理员会话执行 `PawnIO_setup.exe -install -silent`。这些参数来自 Microsoft winget 官方清单；不要沿用 `/S` 或 `/quiet`。
- 使用官方签名版；不需要添加 Defender 排除、关闭内存完整性或启用测试签名。

## 部署结构

将当前目录脚本复制到 Windows 选定的传感器目录（下文为 `$sensorRoot`），同级放置：

```text
sensor_server.ps1
releases/lhm-0.9.6/LibreHardwareMonitorLib.dll 及标准包依赖
packages/               # 官方安装包与版本记录
backups/<时间戳>/       # 旧脚本、原任务 XML/CLIXML
logs/sensor-8086.log    # 超过 1 MiB 后轮替到 .previous
```

先用 PowerShell Parser.ParseFile 检查脚本，再用原任务相同的 principal 创建无触发器的临时测试任务，在 8087 启动脚本。`/health` 的 cpuTemperature/cpuPower 均为 true 且连续原始值有效后，停止旧传感器任务，修改其 Action 为新脚本 `-Port 8086` 并启动。验证成功后删除临时测试任务。只停止已确认的传感器任务，不停止其他用户程序。

完整启动命令（由计划任务承载，工作目录设为 `$sensorRoot`）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$sensorRoot\sensor_server.ps1" -Port 8086
```

既有 TMU-SensorServer 保留登录触发、InteractiveToken / Highest；运行时限 PT0S、失败每分钟重试最多 3 次。此文件不会自动修改其他电脑上的任务或安装驱动。

## 验证与回滚

```powershell
Invoke-RestMethod http://127.0.0.1:8086/health
Invoke-RestMethod http://127.0.0.1:8086/
Get-CimInstance Win32_SystemDriver | Where-Object Name -eq PawnIO
```

验证有效数据、时间戳推进、短时负载后的温度/功耗变化，以及传感器任务重新启动后的健康恢复。驱动安装器退出 3010 时不要擅自重启系统，先报告并取得用户的重启安排。

迁移失败时停止新传感器任务，用备份的 XML 重新注册 TMU-SensorServer 并启动，保留旧库目录。已安装的 PawnIO 不因切回旧任务而自动卸载。现有机器的实际路径、备份位置、签名结果和测试原始值见共享知识库项目档案及本次交付报告；不在仓库中保存凭据。
