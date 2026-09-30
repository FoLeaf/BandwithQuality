<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="BandwithQuality — 高性能、简洁的网络带宽测试工具，右侧为应用的速度仪表盘">
</p>

# BandwithQuality

**高性能、简洁的网络带宽测试工具。** 单文件 Windows 桌面客户端：一键测速、实时速率曲线、IPv4 / IPv6 双栈、本地历史记录。Go 引擎进程内运行，无运行时依赖、免安装、开箱即用。

<p align="center">
  <img src="./assets/readme/showcase.png" width="100%" alt="应用截图：一键开始、实时仪表盘、结果明细与完整曲线">
</p>

## 特性

- **一键测速** — 自动选点（出口探测 → 多级回退择优），默认多线程上下行、13 秒/阶段、16 下行/8 上行连接；单地址族通常约 40 秒，双栈约 1–2 分钟（含探测与排队），可切换单线程对照
- **实时仪表盘** — 500ms 采样逐 tick 推送，指针、刻度与速率曲线实时绘制；最终速率剔除最慢 30% 采样后取均值，贴近可持续带宽
- **手动选点** — 真实节点列表：省市 / 运营商切换浏览、同城优先、节点延迟显示、搜索
- **地址族可选** — IPv4 / IPv6 / V4+V6 双栈，自动探测公网 IPv6 出口，可随时关闭
- **历史与对比** — SQLite 本地存储，历史列表、单次明细曲线、两次测速对比
- **可调参数** — 每阶段时长 5–13s、上下行线程数、线程模式、地址族
- **克制的界面** — 9:16 竖屏窗口，深色仪表盘风格，底栏三页导航（测速 / 历史 / 设置）

## 快速开始

### 下载使用

从 [Releases](https://github.com/FoLeaf/BandwithQuality/releases) 下载最新的 Windows 安装包（`-setup.exe`）或免压缩 zip，安装后打开点 **GO** 即可。

> 安装包未做代码签名：首次运行如遇 SmartScreen 提示，选择「更多信息 → 仍要运行」。

### 从源码构建

依赖：Go ≥ 1.26（wails v2.10 暂不兼容 1.27 的导出格式）、Node ≥ 20、[Wails CLI v2](https://wails.io/docs/gettingstarted/installation)。

```bash
git clone https://github.com/FoLeaf/BandwithQuality.git
cd BandwithQuality

wails dev        # 开发调试（可加 -browser 在浏览器里看）
wails build      # 产出 build/bin/BandwithQuality.exe
```

测试：

```bash
go test ./...
```

前端开发预览（无需 Go 后端，模拟事件流）：

```bash
cd frontend && npm install && npm run dev
# 浏览器打开 http://localhost:5173/?mock=1
```

## 工作原理

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="架构：React 前端通过 Wails 事件桥连接 Go 测速引擎，引擎访问测速节点，结果写入 SQLite">
</p>

- **前端** React 18 + TypeScript + Tailwind + shadcn/ui，负责仪表盘、曲线与交互
- **引擎** `internal/engine`：控制面（HTTPS 选点与排队）、数据面（TCP 流式下载 / 分块上传）、时延面（系统 ICMP ping，Windows 参数修正，失败自动回退 TCP 探测）三层分离，纯 Go 无 cgo
- **事件桥** 引擎每 500ms 推一次采样，经 Wails 事件（`bq:progress` / `bq:sample` / `bq:finished`）直达前端，进程内直连、无子进程
- **存储** modernc.org/sqlite 纯 Go 驱动，历史与设置本地持久化

## 高带宽测试建议

- 新用户默认「多线程」、每阶段 **13 秒**、下行 **16** / 上行 **8** 连接，保留 V4+V6 双栈。已有保存配置不覆盖；可在设置页手动切换。
- 如仍跑不满，再逐步增加到 32 连接。更多连接不一定更快，应以重复实测为准；双栈及较长阶段会增加时间和流量消耗。
- 优先有线连接、同运营商就近节点；单个节点跑不满时换节点对照，不要把远端限速误认为本机瓶颈。
- 引擎采用 256 KiB 传输块、独立连接计数、有限文件/上传请求续开；取消后等待旧连接退出，避免不同阶段互相抢带宽。
- 最终速率剔除最慢 30% 采样后取均值（可持续口径），不等于持续带宽保证；上传仍按本地 socket 成功写入的负载计数，不是远端确认字节数。
- 完整审查、回环基准和验证限制见 [性能审查记录](docs/performance-review.md)。

## 项目结构

```
main.go / app.go        Wails 壳与绑定层
internal/engine         测速引擎（控制面 / 数据面 / 时延 / 编排）
internal/store          SQLite 历史 + 设置持久化
frontend/               React 前端（shadcn/ui + recharts）
cmd/diag                节点连通性诊断小工具
```

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows 10 / 11 | ✅ 提供安装包与免安装 zip |
| macOS / Linux | 同一代码库可编译，后续跟进 |

## 许可

本项目尚未附加开源许可证，默认保留所有权利，仅供个人学习与研究使用。
