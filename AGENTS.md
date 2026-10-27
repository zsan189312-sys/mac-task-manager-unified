# 项目协作说明

核实日期：2026-10-27（Asia/Shanghai）。先读本文件、`README.md`、`mobile/README.md`；跨设备接手再读 `docs/WINDOWS_HANDOFF.md`。版本/部署事实以实际源码、Git 和目标设备检查为准。

## 项目与职责

- `app/`：macOS Electron 桌面端，已发布 v2.2.7。
- `mobile/android/`：原生 Java 安卓客户端，已发布 1.0.3 预览版，API 36，包名 `com.tmu.mobile`。
- `mobile/server/`：N100 上的只读聚合网关；长期运行放 N100，不迁回开发电脑。
- `mobile/mac/`：Mac 按需探针、只读 M4 SMC 温度助手；只能在真实 Mac 验证，不能用 Windows 数据冒充。
- `mobile/windows/`：Windows 独立只读导出器，最近交付时尚未部署/真实联调，接手时重新核实设备状态。

## 工作约定

- 中文沟通，结论先行；交付包含校验项/方法/真实结果、文件改动与资源实测。区分真实设备测试、模拟测试、未验证事项。
- 开工检查 `git status`、当前分支和版本；保留用户修改。不要因换机器重新创建项目、覆盖已有配置或复制整套聊天/个人档案到公开仓库。
- 不固定或伪造频率、温度、功耗、内存容量和历史波动。缺失显示缺失，断线不继续展示旧数据为实时值。
- CPU/GPU 温度的温区传感器数不等于逻辑核心数。Mac 当前显示热点最高值；CPU 封装功耗/实测频率尚未接入。电池净充/放电功率不等于整机输入或充电器功率。
- 1.0.3 已知待办：零电流被当作缺失；插电但电池净放电时方向不明确。仅做过代码审查/模拟，尚未真实插电验收；不要写成已修复。
- 常用回归：`node --test mobile/tests/*.test.cjs`；修改主进程必须 `node --check app/main.js`。测试与改动匹配，真实执行后报告，不反复运行无关检查。

## 构建、凭据与发布

- Windows 接手首先审查 `mobile/android/build.py`。目前它保留 Mac SDK/JDK/工具文件名与私有目录假设，不能直接宣称支持 Windows 构建；详见交接文档。
- Android 升级必须沿用原签名。签名证书 SHA256：`ac5fa6f4ef8f53bfcd85bb18fe8ee18625091bb1190b543a986345b7491ca0d5`。
- 缺少原 `release.jks` 或签名密码时，不运行自动生成新签名的发布流程，不卸载用户手机上的应用绕过签名不一致；可继续做代码/测试，签名在安全迁移完成后进行。
- 私有连接配置、签名密钥、密码、SSH 私钥不进 Git/Release/日志。迁移时只单独传递必要文件；GitHub 登录在新设备自行完成。
- 功能修复升级相关产品版本，安卓同步清单 versionName/versionCode、`mobile/package.json` 与界面显示、README、CHANGELOG；保留历史。桌面同步 `app/package.json`、`sb-ver`、CHANGELOG。纯交接文档提交不改产品版本。
- Android 使用 `android-vX.Y.Z` 标签、同签名 APK 和 SHA256；桌面使用 `vX.Y.Z`，按原桌面交付流程。推送 main/tag 后核对远端提交与 Release 附件 digest。

## 设备操作边界

- 不因接手项目重启 Win11；Windows 删除文件只能原生确认后送回收站，禁止硬删。SFTP 绝对路径使用 `/C:/...`。
- 桌面 `WIN_PS` 编码后 base64 必须小于 8191；修改后实测长度并检查完整命令。不要改变原 LHM/PawnIO 服务或登录任务来迁就手机端。
- Windows exporter 部署前检查原服务、已有任务/防火墙规则及权限；读取 `mobile/README.md` 的后续部署步骤，不直接覆盖同名任务。
- Mac 开发、短时测试与按需采集；N100 正式托管长期服务。清理自己创建的临时进程，不误停其他项目。无用户要求，不增加后台监控或自启。

## macOS 桌面部署铁律

以下仅在目标 Mac、源目录真实存在且确需部署桌面版时执行；Windows 原生环境不要执行。rsync 两端必须全绝对路径，禁止通过 `cd` 和临时变量拼接部署路径。

```sh
rsync -a --delete --exclude='.DS_Store' --exclude='.git' \
  /Users/worldpeace/WorkBuddy/2026-09-20-18-51-12/TaskManagerUnified/app/ \
  "/Applications/任务管理器-统一版.app/Contents/Resources/app/" \
  && codesign --force --deep -s - "/Applications/任务管理器-统一版.app"
```

不能使用 `open` 启动该桌面应用。重启按用户模板：

```sh
pkill -f "任务管理器-统一版.app"; nohup env -u ELECTRON_RUN_AS_NODE \
  "/Applications/任务管理器-统一版.app/Contents/MacOS/Electron" >/tmp/tmu_run.log 2>&1 &
```

Mac 直连 GitHub SSL 失败时，已知备用为 `git -c http.proxy=http://127.0.0.1:7891 push origin <分支或标签>`。此端口是 Mac 的现有配置，不能假设 Windows 也有同一个代理。
