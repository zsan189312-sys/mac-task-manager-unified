# 让 Windows 上的 Codex 接手

核实日期：2026-10-27（Asia/Shanghai）。此为源码与任务交接，不代表已在 Windows 克隆、构建、迁移签名或部署服务。无私有配置/口令内容。

## 1. 获取源码并打开项目

仓库：https://github.com/zsan189312-sys/mac-task-manager-unified

Windows 已安装 Git 时，在 PowerShell 首次克隆：

```powershell
New-Item -ItemType Directory -Force "$HOME\Projects" | Out-Null
git clone https://github.com/zsan189312-sys/mac-task-manager-unified.git "$HOME\Projects\TaskManagerUnified"
```

如果目标目录已有仓库，先查看其 `git status`，确认没有需要保留的本地修改，再用 `git pull --ff-only`；不要覆盖已有目录。

在 Windows Codex 中添加/打开这个本地项目文件夹；原生 Windows 环境使用 PowerShell 即可，不要求为了接手先安装 WSL。把下节文字粘贴为新聊天的首条消息。

```text
接手本仓库的“任务管理器-统一版 / 三端任务管理器”项目。
先读取 AGENTS.md、docs/WINDOWS_HANDOFF.md、README.md、mobile/README.md、mobile/mac/SMC-NOTES.md 和 CHANGELOG.md。
先检查 Git 状态、实际产品版本、Windows 开发工具和可访问的设备，再说明可继续的工作与缺失条件。
安卓功能基线是 1.0.3（android-v1.0.3），桌面仍 v2.2.7；不要重写项目或把未测试设备写成已验收。
下一优先事项：修复 Mac 电池零电流应为0W却显示缺失的问题，以及插电净放电时方向不明确的问题；之后需要真实 Mac 插电验证。
接着适配 Windows 的 Android 构建环境。现有 build.py 有 Mac 路径/工具假设，发布签名在仓库外；未拿到原签名前，不运行会自动生成新签名的发布流程，不卸载手机应用绕过签名冲突。
Windows exporter 尚未部署/真实联调。核实目标 Win11 当前状态与原传感器服务后按文档推进，不重启整机、不覆盖原任务。
保持 N100 为长期采集中心，低资源、真实数据、前后台停采；中文交付实际校验表、资源和文件改动。
```

## 2. 已交付基线

| 项目 | 已核实状态 |
|---|---|
| 安卓 | 1.0.3 预览版；功能基线提交 `83b4228b0a68fa8b7cfdfb7227299a9cb0f9b341`，tag `android-v1.0.3` |
| APK | 包名 `com.tmu.mobile`；versionCode 10003；compile/target API36，min API28；仅 Android16 真机已验证 |
| APK SHA256 | `7fba08049c98d537a49dc177d871b86ef8148eb127dd9a649d412659ffa4b01b` |
| 桌面 | macOS Electron v2.2.7；安卓更新未改 `app/` 或安装副本 |
| N100 | `tmu-mobile.service`，网关源码 `/home/xx/services/tmu-mobile/server`、配置在服务用户私有目录；网关19100，原agent9100 |
| Mac | 按需探针19101，无自启，20分钟闲置退出；M4 SMC只读热点温度，10–150℃有效范围；频率/CPU封装功耗未接入 |
| 已验证 | Mac/N100手机读数、总览动效、CPU网格、详情滚动、100条进程末尾、搜索/切换、断线恢复、刷新设置/冷启动、前后台；后端17项通过 |
| Windows | 最近交付时用户设备无法开机；新的手机exporter未部署/真实联调。开机与网络状态须重新检查 |

当前 HEAD 可能比功能基线多交接文档提交；用 `git log` 查看，不把文档提交当成新的产品版本。

## 3. Windows 能做什么，哪些仍需原设备

- 可继续编辑安卓 Java UI、Node 网关/归一化、Windows PowerShell exporter；先安装/检查 Git、Node.js（项目要求≥18）、Python、JDK17、Android SDK（platforms/android-36、build-tools/36.0.0、platform-tools）。不要假定这些已存在。
- `node --test mobile/tests/*.test.cjs` 可先验证纯代码路径；实际测试结果必须当次记录，源码中17项通过的历史不能代替新环境运行。
- Android 现有 `build.py` 默认 `~/Library/Android/sdk`、`/opt/homebrew/opt/openjdk@17`，命令使用无后缀工具名及 Unix PATH 拼接，签名路径也假设 Mac。Windows 需适配 `.exe`/`.bat` 调用、环境变量、PATH 与私有配置路径，或另做经验证的构建入口。**仅安装 Android Studio 并不能证明当前脚本能直接运行。**
- macOS Electron、AppleSMC 温度、Mac 电池充电真实验证与应用签名部署仍需 Mac；Windows 端可以修改对应代码，但不能本地伪造硬件验收。通过 Git 把改动同步回 Mac 测试。
- 安卓真机若改接 Windows USB，需要在手机上再次允许这台电脑的 ADB 调试。不要转移 Mac 的 ADB 私钥来绕过授权。
- Windows exporter 需要真实 Win11 与原 LHM/PawnIO 传感器服务；N100 网关长期留在 N100，不复制生产中心到 Windows。

## 4. 优先待办：充电边界

这是 1.0.3 发布后的审查/模拟发现，尚未修复，尚未进行真实充电测试：

1. `mobile/mac/desktop-collectors.cjs` 的 `localBattery()` 用 `voltage && amperage` 判断，电流0会返回null，应区分缺失和合法0W。
2. 外接电源而电池净放电的模拟：12V×-0.5A=-6W，状态为external；Android取绝对值后显示“电池功率6W”，方向不明确。需在数据/显示中保留正确能量方向。
3. 普通充电模拟12V×1A=12W，口径为电池净充入，不能改名为整机功耗或充电器实际输出。CPU/GPU功耗仍缺失。
4. 需覆盖充电、零电流/暂停充电、放电、外接电源且电池放电、缺失读数，并在真实Mac插/拔电后验收；不要用模拟结果冒充硬件结果。

## 5. 私有材料与发布身份

这些不在 Git 中，Windows 新环境不会因克隆自动获得：

- Mac 私有目录：`/Users/worldpeace/Library/Application Support/TMU-Mobile/`。按需配置文件名包括 `gateway.json`、`mac.json`、`windows.json`、`pairing.json`；不是所有开发任务都需要迁移全部配置。
- Android 原签名：该目录的 `signing/release.jks`、`signing/password`。原证书 SHA256 `ac5fa6f4ef8f53bfcd85bb18fe8ee18625091bb1190b543a986345b7491ca0d5`。
- 原构建脚本在缺少 keystore 时会创建新密钥。适配Windows时必须先设计“发布缺签名即失败”的入口；未安全迁移/明确使用原签名，不能声称构建包可覆盖升级。
- 密钥/口令只能经用户认可的方式私下迁移并存入新设备受限目录；不把内容贴聊天、写笔记、提交Git或附Release。不复制Mac的SSH/GitHub认证缓存，Windows自行登录并核实远程访问权限。
- Mac 的 iCloud 共享知识库不是仓库文件，不能假设 Windows 能读到。本文件汇总接手需要的项目事实；更完整的私人档案只在本机/iCloud，不上传来替代交接。

## 6. 进一步操作资料

- `mobile/README.md`：架构、N100运维、Windows exporter安装/回滚顺序。
- `mobile/mac/SMC-NOTES.md`：真实温度口径、已验证M4映射、SMC只读范围/许可。
- `CHANGELOG.md`：历史版本，不删除。
- `AGENTS.md`：版本/签名/校验、Windows回收站、WIN_PS长度限制及Mac绝对路径部署铁律。

Codex官方操作参考（2026-10-27核对）：[Windows环境](https://learn.chatgpt.com/docs/app/windows)、[项目与聊天](https://learn.chatgpt.com/docs/projects)、[项目AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。
