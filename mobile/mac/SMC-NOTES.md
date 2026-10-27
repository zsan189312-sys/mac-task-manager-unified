# Mac 温度读取说明

2026-10-27 在 Apple M4 MacBook Air 上，以普通登录用户实测 AppleSMC 可读。此前 mobile 探针没有接入温度，不代表硬件一定不可读。

- `smc-temps.c` 是一次运行后退出的只读 IOKit 小助手，只使用元信息查询（9）和字节读取（5），不含 SMC 写入、风扇控制、驱动或特权常驻进程。
- 启动脚本按源码 SHA-256 构建到私有 Application Support 目录；只在源码变更时编译，不每轮编译。每次授权采样并入既有 4.5 秒缓存；不可读时返回缺失，不影响其他指标。
- M4 CPU/GPU 温度按各自有效传感器的**最高值**显示，UI 标为“热点”。这些是芯片温区传感器，数量不等于物理/逻辑核心数；不提供虚构的逐核心温度或“CPU 封装平均温度”。采用 10–150℃ 有效范围，丢弃非有限值、0、负数和休眠时实测出现的 0.1℃ 占位读数；不可读时保留缺失，不拿其他温区补齐。
- 仅启用本机已验证的 `Apple M4` 映射。其他机型继续显示未验证原因，不能盲用 M4 键。CPU 封装功耗/实测频率仍缺失，不把电池放电功率混作 CPU 功耗。

SMC ABI 与 M4 键名参考 [Stats smc.swift](https://github.com/exelban/stats/blob/69efd1c0d581af80c27d3fbe23d62b729588cbff/SMC/smc.swift) 和 [M4 SensorsList](https://github.com/exelban/stats/blob/69efd1c0d581af80c27d3fbe23d62b729588cbff/Modules/Sensors/values.swift)。本项目实现为精简 C 只读探针；参考项目 MIT 许可保留如下：

MIT License

Copyright (c) 2019 Serhiy Mytrovtsiy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
