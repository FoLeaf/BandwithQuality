// Package engine 实现网络带宽测速的客户端引擎：
// 控制面选点、TCP/HTTP 数据面吞吐测量、ICMP/TCP 时延，并以实时采样回调驱动前端曲线。
package engine

import "time"

// 阶段标识，前后端约定的稳定字符串。
const (
	PhaseDownSingle = "down_single"
	PhaseUpSingle   = "up_single"
	PhaseDownMulti  = "down_multi"
	PhaseUpMulti    = "up_multi"
)

// 运行模式。
const (
	ModeBoth   = "both"   // 单线程 + 多线程对照
	ModeSingle = "single" // 仅单线程
	ModeMulti  = "multi"  // 仅多线程
)

// 地址族选项。
const (
	FamilyV4   = "v4"   // 仅 IPv4
	FamilyV6   = "v6"   // 仅 IPv6
	FamilyBoth = "both" // IPv4 + IPv6（v6 不可用时自动回退仅 v4）
)

const (
	FamilyIPv4 = "IPv4"
	FamilyIPv6 = "IPv6"
)

// Node 测速节点。
type Node struct {
	HostID   string  `json:"hostId"`
	HostName string  `json:"hostName"`
	HostIP   string  `json:"hostIp"`
	Port     int     `json:"port"`
	PName    string  `json:"pname"` // 节点所在省
	City     string  `json:"city"`
	Oper     string  `json:"oper"`
	PingMS   float64 `json:"pingMs"` // 列表快速探测时填充，-1 表示不可达
}

// DisplayName 形如「武汉电信」的短名。
func (n Node) DisplayName() string {
	s := n.City + n.Oper
	if s == n.Oper || s == "" {
		s = n.PName + n.Oper
	}
	if s == n.Oper || s == "" {
		s = n.HostName
	}
	return s
}

// ClientLocation 出口网络探测结果。
type ClientLocation struct {
	IP       string `json:"ip"`
	Province string `json:"province"`
	City     string `json:"city"`
	Oper     string `json:"oper"`
}

// Options 一次测速的参数。
type Options struct {
	Node        *Node  `json:"node"`        // nil = 自动选点（仅作用于 IPv4 轮）
	Mode        string `json:"mode"`        // both | single | multi
	LengthS     int    `json:"lengthS"`     // 每阶段时长 5..13 秒
	IntervalMS  int    `json:"intervalMs"`  // 采样间隔毫秒，默认 500
	DownThreads int    `json:"downThreads"` // 多线程下行连接数，默认 8
	UpThreads   int    `json:"upThreads"`   // 多线程上行连接数，默认 4
	Family      string `json:"family"`      // v4 | v6 | both
	IPv6        bool   `json:"ipv6"`        // 旧字段（已废弃）：Family 为空时按它推导 v4/both
}

func (o *Options) fill() {
	if o.Mode != ModeSingle && o.Mode != ModeMulti {
		o.Mode = ModeBoth
	}
	switch o.Family {
	case FamilyV4, FamilyV6, FamilyBoth:
	default:
		if o.IPv6 {
			o.Family = FamilyBoth
		} else {
			o.Family = FamilyV4
		}
	}
	if o.LengthS < 5 {
		o.LengthS = 5
	}
	if o.LengthS > 13 {
		o.LengthS = 13
	}
	if o.IntervalMS < 100 {
		o.IntervalMS = 500
	}
	if o.DownThreads < 1 {
		o.DownThreads = 8
	}
	if o.UpThreads < 1 {
		o.UpThreads = 4
	}
}

// Sample 一个采样点的瞬时速率，用于前端画实时曲线。
type Sample struct {
	Family    string  `json:"family"`
	Phase     string  `json:"phase"`
	Index     int     `json:"index"`
	ElapsedS  float64 `json:"elapsedS"`
	SpeedMbps float64 `json:"speedMbps"`
}

// Progress 阶段进度事件。
type Progress struct {
	Stage   string  `json:"stage"` // probe|nodes|select|latency|phase:<name>|done|error
	Message string  `json:"message"`
	Percent float64 `json:"percent"`
	// LatencyDone 事件附带实测时延/抖动，供前端实时面板即时显示
	LatencyMS *float64 `json:"latencyMs,omitempty"`
	JitterMS  *float64 `json:"jitterMs,omitempty"`
}

// PhaseResult 单个阶段的最终速率（avgTop3 口径，与官方客户端一致）。
type PhaseResult struct {
	Phase string  `json:"phase"`
	Mbps  float64 `json:"mbps"`
}

// FamilyResult 一个地址族（IPv4/IPv6）一轮的完整结果。
type FamilyResult struct {
	Family    string        `json:"family"`
	Node      *Node         `json:"node"`
	LatencyMS float64       `json:"latencyMs"` // -1 表示失败
	JitterMS  float64       `json:"jitterMs"`
	Phases    []PhaseResult `json:"phases"`
	Samples   []Sample      `json:"samples"`
	Error     string        `json:"error,omitempty"`
}

// PhaseMbps 按阶段名取最终速率，缺失返回 -1。
func (f FamilyResult) PhaseMbps(phase string) float64 {
	for _, p := range f.Phases {
		if p.Phase == phase {
			return p.Mbps
		}
	}
	return -1
}

// TestResult 一次完整测速的结果。
type TestResult struct {
	Client    ClientLocation `json:"client"`
	StartedAt time.Time      `json:"startedAt"`
	DurationS float64        `json:"durationS"`
	Families  []FamilyResult `json:"families"`
}

// Callbacks 引擎在运行过程中通过这两个回调推送事件；可为 nil。
type Callbacks struct {
	OnProgress func(Progress)
	OnSample   func(Sample)
}

// PhaseLabel 阶段的中文名（family 仅用于区分展示，可为空）。
func PhaseLabel(phase, family string) string {
	s := map[string]string{
		PhaseDownSingle: "单线程下行",
		PhaseUpSingle:   "单线程上行",
		PhaseDownMulti:  "多线程下行",
		PhaseUpMulti:    "多线程上行",
	}[phase]
	if family != "" {
		return family + " " + s
	}
	return s
}

// phaseList 按模式给出阶段顺序：单线程上下行在前，多线程在后。
func phaseList(mode string) []string {
	switch mode {
	case ModeSingle:
		return []string{PhaseDownSingle, PhaseUpSingle}
	case ModeMulti:
		return []string{PhaseDownMulti, PhaseUpMulti}
	default:
		return []string{PhaseDownSingle, PhaseUpSingle, PhaseDownMulti, PhaseUpMulti}
	}
}
