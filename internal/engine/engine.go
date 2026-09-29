package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"
)

// 控制面 base 与出口探测结果的进程级缓存（Wails 一次启动只探测一次）。
var (
	probeMu   sync.Mutex
	probeBase string
	probeLoc  ClientLocation
)

// Probe 探测出口网络（复用缓存；force=true 时强制重新探测）。
func Probe(force bool) (ClientLocation, error) {
	probeMu.Lock()
	defer probeMu.Unlock()
	if !force && probeBase != "" {
		return probeLoc, nil
	}
	base, info, err := fetchClient()
	if err != nil {
		return ClientLocation{}, err
	}
	probeBase = base
	probeLoc = info.location()
	return probeLoc, nil
}

func controlBase() (string, ClientLocation, error) {
	probeMu.Lock()
	defer probeMu.Unlock()
	if probeBase == "" {
		base, info, err := fetchClient()
		if err != nil {
			return "", ClientLocation{}, err
		}
		probeBase = base
		probeLoc = info.location()
	}
	return probeBase, probeLoc, nil
}

// ListNodes 拉取候选节点列表（手动选点用）。
// opt 为空的字段回退到探测到的出口位置；指定省份而未指定城市时用省会兜底。
func ListNodes(opt ListOptions) ([]Node, error) {
	_, loc, err := controlBase()
	if err != nil {
		return nil, err
	}
	prov, city, oper := loc.Province, loc.City, loc.Oper
	if opt.Province != "" {
		if p, _, err := resolveLocation(opt.Province); err == nil {
			prov = p
		} else {
			prov = opt.Province
		}
		if opt.City == "" {
			if cap := CapitalOf(prov); cap != "" {
				city = cap
			}
		}
	}
	if opt.City != "" {
		if _, c, err := resolveLocation(opt.City); err == nil {
			city = c
		} else {
			city = opt.City
		}
	}
	if opt.Oper != "" {
		oper = opt.Oper
	}
	nodes, err := matchServersByLoc(prov, city, oper, opt.IPv6)
	if err != nil {
		return nil, err
	}
	if !opt.NoPing {
		FillQuickPing(nodes)
	}
	return nodes, nil
}

// ListOptions 手动选点列表的过滤参数。
type ListOptions struct {
	Province string `json:"province"` // 空 = 出口省份
	City     string `json:"city"`     // 空 = 省会（若指定了省份）
	Oper     string `json:"oper"`     // 空 = 出口运营商
	IPv6     bool   `json:"ipv6"`
	NoPing   bool   `json:"noPing"` // 跳过列表快速 ping
}

func matchServersByLoc(prov, city, oper string, ipv6 bool) ([]Node, error) {
	base, loc, err := controlBase()
	if err != nil {
		return nil, err
	}
	return matchServers(base, loc.IP, prov, city, oper, ipv6)
}

// AutoSelect 按上游三级回退自动选一个节点（不排队）。
func AutoSelect(opt ListOptions) (*Node, []Node, error) {
	nodes, err := ListNodes(opt)
	if err != nil {
		return nil, nil, err
	}
	if len(nodes) == 0 {
		return nil, nodes, fmt.Errorf("无可用节点")
	}
	_, loc, _ := controlBase()
	prov, city, oper := loc.Province, loc.City, loc.Oper
	if opt.Province != "" {
		prov = opt.Province
	}
	if opt.City != "" {
		city = opt.City
	}
	if opt.Oper != "" {
		oper = opt.Oper
	}
	return pickNode(nodes, prov, city, oper, tcpOK), nodes, nil
}

// PingNode 按需测单个节点的时延/抖动（手动选点刷新）。
func PingNode(n Node) (avgMs, jitterMs float64) {
	return MeasureLatency(n.HostIP, n.Port)
}

// makeIMEI 每次测速生成随机设备标识（上游做法）。
func makeIMEI() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "TS" + strings.ToUpper(hex.EncodeToString(b))
}

func emit(cb Callbacks, stage, msg string, pct float64) {
	if cb.OnProgress != nil {
		cb.OnProgress(Progress{Stage: stage, Message: msg, Percent: pct})
	}
}

// enqueueMaxTries 排队尝试的节点总数上限（主选 + 备选）。上游节点排队服务
// 间歇性无响应（实测超时率可达 60%，且同城/同省节点更容易集体挂起），
// 候选太少很容易全军覆没。
const enqueueMaxTries = 6

// shortEnqueueErr 把排队失败的底层错误压缩成一句话（原始错误含完整 URL，不适合直接展示）。
func shortEnqueueErr(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "Client.Timeout") || strings.Contains(msg, "deadline exceeded"):
		return "排队请求超时"
	case strings.Contains(msg, "服务器忙"):
		return "服务器忙"
	case strings.Contains(msg, "参数错误"):
		return "参数被拒"
	default:
		return "服务异常"
	}
}

// enqueueWithFallback 首选节点排队；dovalid 超时/拒绝时自动换下一个 TCP 可达节点
// （至多再试 5 个）。手动指定节点时 nodes 为空，只按上游的 3 次内部重试。
func enqueueWithFallback(ctx context.Context, nodes []Node, primary *Node, imei string) (string, *Node, error) {
	tried := []*Node{primary}
	if primary != nil {
		// 按步长跨列表取样：上游列表同城/同省靠前，顺序取会与主选高度同质，
		// 集体挂起时全军覆没；跨列表取可分散地理命中面。
		step := 1
		if len(nodes) > enqueueMaxTries {
			step = len(nodes) / enqueueMaxTries
		}
		for i := 0; i < len(nodes) && len(tried) < enqueueMaxTries; i += step {
			n := &nodes[i]
			if n.HostIP == primary.HostIP && n.Port == primary.Port {
				continue
			}
			if tcpOK(n.HostIP, n.Port) {
				tried = append(tried, n)
			}
		}
	}
	var lastErr error
	for _, n := range tried {
		if n == nil {
			continue
		}
		if ctx.Err() != nil {
			return "", nil, ctx.Err()
		}
		uuid, err := enqueue(*n, imei, 200)
		if err == nil {
			return uuid, n, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		return "", nil, fmt.Errorf("无可用节点")
	}
	return "", nil, fmt.Errorf("节点排队失败：已尝试 %d 个节点均未成功（%s），上游排队服务可能暂时不稳定，请稍后重试或手动更换节点", len(tried), shortEnqueueErr(lastErr))
}

// RunTest 执行一次完整测速：出口探测 → 选点 → 排队 → 时延 → 各阶段吞吐 → 退队。
// opts.Node 非 nil 时 IPv4 轮使用该节点（IPv6 轮仍自动择优）；
// opts.Family 决定地址族：v4 仅 IPv4，v6 仅 IPv6（无 v6 出口直接报错），
// both 先测 IPv4，网络具备 v6 互联网时附加一轮 IPv6。
// 通过 cb.OnProgress / cb.OnSample 实时推送进度与采样点。
func RunTest(ctx context.Context, opts Options, cb Callbacks) (*TestResult, error) {
	opts.fill()
	base, loc, err := controlBase()
	if err != nil {
		return nil, err
	}
	emit(cb, "probe", fmt.Sprintf("出口：%s %s %s（%s）", loc.Province, loc.City, loc.Oper, loc.IP), 4)

	type fam struct {
		name string
		v6   bool
	}
	var fams []fam
	switch opts.Family {
	case FamilyV6:
		emit(cb, "probe", "检测 IPv6 可用性…", 6)
		if HasIPv6Internet() {
			fams = append(fams, fam{FamilyIPv6, true})
		} else {
			result := &TestResult{Client: loc, StartedAt: time.Now()}
			result.Families = append(result.Families,
				FamilyResult{Family: FamilyIPv6, LatencyMS: -1, Error: "当前网络无 IPv6 出口"})
			emit(cb, "error", "IPv6 不可用，无法进行 IPv6 测速", 100)
			return result, fmt.Errorf("IPv6 不可用，无法进行 IPv6 测速")
		}
	case FamilyBoth:
		fams = append(fams, fam{FamilyIPv4, false})
		emit(cb, "probe", "检测 IPv6 可用性…", 6)
		if HasIPv6Internet() {
			fams = append(fams, fam{FamilyIPv6, true})
			emit(cb, "probe", "IPv6 可用，将附加一轮 IPv6 测试", 8)
		} else {
			emit(cb, "probe", "IPv6 不可用，仅测 IPv4", 8)
		}
	default: // FamilyV4
		fams = append(fams, fam{FamilyIPv4, false})
	}

	result := &TestResult{Client: loc, StartedAt: time.Now()}
	defer func() { result.DurationS = time.Since(result.StartedAt).Seconds() }()

	imei := makeIMEI()
	phases := phaseList(opts.Mode)
	span := 100.0 / float64(len(fams)*len(phases))

	for fi, f := range fams {
		result.Families = append(result.Families, FamilyResult{Family: f.name, LatencyMS: -1})
		fr := &result.Families[fi]
		phaseBase := float64(fi) * span * float64(len(phases))

		var nodes []Node
		var node *Node
		// 手动指定节点只作用于 IPv4 轮（选点列表来自 v4 接口，v6 轮仍自动择优）
		if fi == 0 && opts.Node != nil && !f.v6 {
			node = opts.Node
		} else {
			emit(cb, "nodes", "获取节点列表…", phaseBase+span*0.1)
			var err error
			nodes, err = matchServers(base, loc.IP, loc.Province, loc.City, loc.Oper, f.v6)
			if err != nil {
				fr.Error = err.Error()
				continue
			}
			if len(nodes) == 0 {
				fr.Error = "无可用节点"
				continue
			}
			node = pickNode(nodes, loc.Province, loc.City, loc.Oper, tcpOK)
		}
		emit(cb, "select", fmt.Sprintf("为你选择了：%s ×%s", node.DisplayName(), shortIP(node.HostIP)), phaseBase+span*0.2)

		uuid, chosen, err := enqueueWithFallback(ctx, nodes, node, imei)
		if err != nil {
			fr.Error = err.Error()
			continue
		}
		node = chosen
		fr.Node = node
		if fi != 0 || opts.Node == nil {
			emit(cb, "select", fmt.Sprintf("为你选择了：%s ×%s", node.DisplayName(), shortIP(node.HostIP)), phaseBase+span*0.25)
		}
		func() {
			defer dequeue(*node, uuid)

			emit(cb, "latency", "测量延迟…", phaseBase+span*0.3)
			fr.LatencyMS, fr.JitterMS = MeasureLatency(node.HostIP, node.Port)
			if cb.OnProgress != nil {
				lat, jit := fr.LatencyMS, fr.JitterMS
				cb.OnProgress(Progress{
					Stage: "latency_done", Message: "延迟测量完成",
					Percent: phaseBase + span*0.35, LatencyMS: &lat, JitterMS: &jit,
				})
			}

			for pi, ph := range phases {
				if ctx.Err() != nil {
					fr.Error = ctx.Err().Error()
					return
				}
				threads, down := opts.UpThreads, false
				switch ph {
				case PhaseDownSingle:
					threads, down = 1, true
				case PhaseUpSingle:
					threads, down = 1, false
				case PhaseDownMulti:
					threads, down = opts.DownThreads, true
				}
				stage := "phase:" + ph
				emit(cb, stage, PhaseLabel(ph, f.name), phaseBase+span*(float64(pi)+0.35))
				mbps := runPhase(ctx, *node, uuid, down, threads, opts.LengthS, opts.IntervalMS,
					func(index, total int, speed, elapsed float64) {
						s := Sample{Family: f.name, Phase: ph, Index: index, ElapsedS: elapsed, SpeedMbps: speed}
						fr.Samples = append(fr.Samples, s)
						if cb.OnSample != nil {
							cb.OnSample(s)
						}
					})
				if ctx.Err() != nil {
					fr.Error = ctx.Err().Error()
					return
				}
				if mbps <= 0 {
					fr.Error = PhaseLabel(ph, f.name) + "未收到有效测速数据，请更换节点"
					return
				}
				fr.Phases = append(fr.Phases, PhaseResult{Phase: ph, Mbps: mbps})
				emit(cb, stage, PhaseLabel(ph, f.name)+"完成", phaseBase+span*float64(pi+1))
			}
		}()
		if ctx.Err() != nil {
			emit(cb, "error", "测速已取消", 100)
			return result, ctx.Err()
		}
	}
	emit(cb, "done", "测速完成", 100)
	return result, nil
}

// shortIP 隐藏 IP 中段，展示友好（1.2.x.x）。
func shortIP(ip string) string {
	if strings.Contains(ip, ":") {
		return ip // v6 不截
	}
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return parts[0] + "." + parts[1] + ".*.*"
	}
	return ip
}
