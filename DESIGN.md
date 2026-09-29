# bandwidthquality — 泰尔测速桌面客户端设计文档

> 基于对 [MiaM1ku/taierspeedtest](https://github.com/MiaM1ku/taierspeedtest) 源码的调研定稿。
> 日期：2026-09-28

## 1. 产品定位

- **测什么**：本机 → 泰尔官方测速节点（全球网测）的网络质量。不做 VPS 遥测、不做公开托管服务。
- **给谁用**：自己及小圈子，代码开源但仓库起步为**私有**。
- **形态**：桌面应用，单个 exe，中文界面。
- **明确不做**（v1）：公开托管、鉴权/用户系统、结果分享图、多节点批量对比、图床上传。

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 壳 | **Wails v2**（Go + 系统 WebView） | Windows/macOS/Linux 三平台一套代码；产物单 exe；Go 引擎直接进程内调用，无 FFI/子进程 |
| 前端 | **React + TS + Vite + Tailwind + shadcn/ui** | 原汁原味 shadcn；Wails 内嵌静态构建 |
| 引擎 | **魔改上游 Go 源码**，抽成内部包 | 上游 protocol/measure 函数签名干净、无可变全局，抽取难度低到中 |
| 存储 | **SQLite（modernc.org/sqlite，纯 Go 无 cgo）** | Wails 交叉编译友好 |
| 图表 | 实时速率曲线（Wails Events 推送）+ 延迟/抖动 | 每 500ms 采样，前端 shadcn charts/recharts |

> 曾评估并否决：Flutter（shadcn 无法使用、引擎需重写）、Rust 引擎（网络 IO 密集场景无性能收益）、子进程方案（拿不到实时采样，已被源码魔改取代）。

## 3. 引擎设计（源码魔改要点）

### 移植
- **控制面**（HTTPS，主 `dlcv2.cnspeedtest.cn:8443`，两个 HTTP 备用）：
  - `getIpLocSP.php` — 出口 IP/省/市/运营商探测
  - `mobilematch_many.php` — 按位置拉候选节点列表
  - `dovalid` 排队/退队；MD5 token（imei+stime/band/rand）；Dalvik UA
- **数据面**：裸 TCP 下载 `GET /speed/File(1G).dl`（64KB 读缓冲、总 30s 截止、单读 3s 截止）；上传 `POST` multipart 谎报 `Content-Length` 循环写 16KB 随机块
- **采样**：500ms tick、跳过前 2s 预热、avgTop3 平滑 —— **新增实时回调**：每个 tick 把瞬时速率推给前端画曲线；最终数字仍按 avgTop3 口径（与官方一致）
- **延迟**：exec 系统 ping，**按平台修参数**（Windows `-n`/`-w` 毫秒 ← 上游 bug 修正；Unix `-c`/`-W`）；失败回退 TCP tcping。Windows 修正后是真 ICMP 且无需管理员
- **地址族**：family = v4/v6/both；both 时探测（Google/Ali DNS）命中则附加一轮 v6 完整测试
- **选点**：复用上游三级回退（同运营商+省市匹配 → TCP 可达性探测 → 兜底 servers[0]）

### 不移植
`interactive()`（CLI 交互）、图床上传与 PNG 渲染链路（`publishReport`、内嵌字体）、结果表 stdout 打印。

## 4. v1 功能规格

1. **一键测速**：默认自动选节点；显示"为你选择了：武汉电信 ×节点"，可切换手动。单线程+多线程一次对照，每阶段 5s（可调 5–13s），全程约 30–40s
2. **自动选节点**：出口探测（省市+运营商）→ 服务器候选 → 三级回退择优
3. **手动选节点**：真实节点列表（`mobilematch_many.php`），城市+运营商分组、同城优先、可切省份浏览全国、显示节点延迟、支持搜索
4. **实时图表**：下行/上行速率曲线 + 延迟/抖动
5. **结果页**：单线程上下行、多线程上下行、延迟，大数字卡片 + 曲线
6. **历史记录**：SQLite 存储、历史列表与对比视图
7. **地址族选择**：默认 V4+V6（双栈；注明选 v6/both 后测速时间相应增加）

## 5. 平台与分发

- v1 发 **Windows exe**（未签名，SmartScreen 警告属预期，"更多信息→仍要运行"）
- macOS/Linux 同代码可编译，后续跟进
- 仓库/module 名：`bandwidthquality`（已修正拼写；本地文件夹名不强制改）

## 6. 风险登记

- 上游**无 LICENSE**（保留所有权利）+ 协议逆向 → 衍生代码走私有分发；可尝试请求作者授权后再公开
- 泰尔官方改接口/封禁第三方 → 全体用户测速失效，修复取决于上游/社区
- 协议为逆向实现，官方条款"仅供个人网络质量测试"

## 7. 里程碑

- **M1 引擎抽取**：CLI 剥离 → engine 包 + 采样/进度回调 + 单测
- **M2 壳与骨架**：Wails 工程 + shadcn 前端骨架 + 一键测速端到端跑通
- **M3 体验完整**：实时图表、自动/手动选节点
- **M4 收尾**：历史记录、IPv6 开关、打包（Windows exe）
