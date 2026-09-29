# 泰尔测速 · BandwidthQuality

本机 → 泰尔「全球网测」官方测速节点的网络质量桌面客户端。Windows 单 exe，中文界面。

> 协议实现改造自开源项目 [MiaM1ku/taierspeedtest](https://github.com/MiaM1ku/taierspeedtest)（上游无 LICENSE，保留所有权利）。仅供个人网络质量测试研究，请勿用于商业用途。

## 功能

- **一键测速**：自动选点（出口探测 → 三级回退择优），单线程 + 多线程上下行对照
- **实时曲线**：500ms 采样逐 tick 推送，速率曲线实时绘制；最终数值取最高 3 个采样均值（与官方口径一致）
- **手动选点**：真实节点列表，省市/运营商切换浏览、同城优先、节点延迟显示、搜索
- **地址族可选**：IPv4 / IPv6 / V4+V6 双栈（检测到 v6 出口才附加，可关）
- **历史记录**：SQLite 本地存储，列表 / 明细曲线 / 两次对比
- **可调参数**：每阶段 5–13s、多线程连接数、线程模式、地址族；窗口 9:16 竖屏 + 底栏导航

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | [Wails v2](https://wails.io)（Go + 系统 WebView，单 exe） |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui + recharts |
| 引擎 | `internal/engine` —— 上游 Go 源码魔改抽取，剥离 CLI，加采样回调与 Windows ping 修正 |
| 存储 | SQLite（modernc.org/sqlite 纯 Go，无 cgo） |

## 开发

依赖：Go ≥1.26（wails v2.10 类型加载器暂不兼容 1.27 导出格式）、Node ≥20、[Wails CLI v2](https://wails.io/docs/gettingstarted/installation)。

```bash
wails dev        # 开发（可加 -browser 在浏览器里调试）
wails build      # 产出 build/bin/BandwidthQuality.exe
```

测试：

```bash
go test ./...
```

Windows 首次运行未签名 exe 会有 SmartScreen 提示：「更多信息 → 仍要运行」。

## 结构

```
main.go / app.go        Wails 壳与绑定层（事件：bq:progress / bq:sample / bq:finished）
internal/engine         测速引擎（控制面 + 数据面 + 时延 + 编排）
internal/store          SQLite 历史 + 设置持久化
frontend/               React 前端（shadcn/ui）
```
