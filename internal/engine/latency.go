package engine

import (
	"bufio"
	"context"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// pingArgs 按平台拼 ping 参数。
// 上游把 Windows/Unix 参数混用（`-n -c 4 -W 1`），在 Windows 上必然失败 —— 已修正：
// Windows: -n 个数 -w 超时(毫秒)，真 ICMP，无需管理员；
// Linux:   -c 个数 -W 超时(秒)；
// macOS:   -c 个数 -W 超时(毫秒)。
func pingArgs(count int, ipv6 bool) []string {
	var args []string
	switch runtime.GOOS {
	case "windows":
		args = []string{"-n", strconv.Itoa(count), "-w", "1000"}
	case "darwin":
		args = []string{"-c", strconv.Itoa(count), "-W", "1000"}
	default:
		args = []string{"-c", strconv.Itoa(count), "-W", "1"}
	}
	if ipv6 {
		args = append(args, "-6")
	}
	return args
}

// msRe 匹配回复行里的时延值：`time=23ms`、`时间=5ms`（GBK 中文输出按字节也能匹配 ASCII）、
// `time=12.3 ms`（Linux）、`time<1ms`（Windows，按 1ms 计）。
var msRe = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s*ms`)

// parsePingOutput 只解析含 TTL 的回复行，天然排除「最短/平均/Minimum」等统计行。
func parsePingOutput(out string) []float64 {
	var times []float64
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(strings.ToLower(line), "ttl") {
			continue
		}
		matches := msRe.FindAllStringSubmatch(line, -1)
		if len(matches) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(matches[len(matches)-1][1], 64)
		if err == nil {
			times = append(times, v)
		}
	}
	return times
}

// pingSamples 发 count 个 ICMP 包返回逐包时延；进程有输出但退出码非 0（部分丢包）也照常解析。
// ctx 取消会立即杀掉 ping 进程（用户停止测速时时延阶段及时退出）。
func pingSamples(ctx context.Context, ip string, count int) []float64 {
	if count < 1 {
		count = 4
	}
	args := pingArgs(count, strings.Contains(ip, ":"))
	args = append(args, ip)
	cctx, cancel := context.WithTimeout(ctx, time.Duration(count+2)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "ping", args...)
	cmd.SysProcAttr = sysProcAttrNoWindow()
	out, err := cmd.Output()
	if len(out) > 0 {
		if ts := parsePingOutput(string(out)); len(ts) > 0 {
			return ts
		}
	}
	if err != nil {
		return nil
	}
	return nil
}

// tcpingSamples ICMP 不可用时的回退：向节点端口发 HTTP 请求测往返时延。
func tcpingSamples(ctx context.Context, ip string, port, count int) []float64 {
	req := []byte("GET / HTTP/1.1\r\nHost: " + hostPort(ip, port) + "\r\nConnection: close\r\n\r\n")
	d := net.Dialer{Timeout: 2 * time.Second}
	var samples []float64
	for i := 0; i < count+1; i++ {
		if ctx.Err() != nil {
			return samples
		}
		t0 := time.Now()
		c, err := d.DialContext(ctx, "tcp", hostPort(ip, port))
		if err != nil {
			if !sleepCtx(ctx, 50*time.Millisecond) {
				return samples
			}
			continue
		}
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := c.Write(req); err != nil {
			_ = c.Close()
			continue
		}
		buf := make([]byte, 64)
		n, err := c.Read(buf)
		_ = c.Close()
		if err == nil && n > 0 {
			samples = append(samples, float64(time.Since(t0).Microseconds())/1000.0)
		}
		if !sleepCtx(ctx, 50*time.Millisecond) {
			return samples
		}
	}
	return samples
}

// sleepCtx 可中断的固定等待；ctx 取消返回 false。
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func avgMS(samples []float64) float64 {
	if len(samples) == 0 {
		return -1
	}
	sum := 0.0
	for _, v := range samples {
		sum += v
	}
	return sum / float64(len(samples))
}

// jitterMS 相邻样本平均绝对差（RFC3550 风格的简化抖动口径）。
func jitterMS(samples []float64) float64 {
	if len(samples) < 2 {
		return 0
	}
	sum := 0.0
	for i := 1; i < len(samples); i++ {
		d := samples[i] - samples[i-1]
		if d < 0 {
			d = -d
		}
		sum += d
	}
	return sum / float64(len(samples)-1)
}

// MeasureLatency 测节点时延与抖动：ICMP 4 包优先，失败回退 TCP tcping。
// 失败返回 -1。供手动单点测量等无取消场景使用。
func MeasureLatency(ip string, port int) (avgMs, jitterMs float64) {
	return measureLatencyCtx(context.Background(), ip, port)
}

// measureLatencyCtx 同 MeasureLatency，但随 ctx 取消及时退出（测速引擎用）。
func measureLatencyCtx(ctx context.Context, ip string, port int) (avgMs, jitterMs float64) {
	samples := pingSamples(ctx, ip, 4)
	if len(samples) == 0 {
		samples = tcpingSamples(ctx, ip, port, 4)
	}
	if len(samples) == 0 {
		return -1, 0
	}
	return avgMS(samples), jitterMS(samples)
}

// QuickPing 列表快速探测：1 个 ICMP 包，不通返回 -1。
func QuickPing(ip string) float64 {
	ts := pingSamples(context.Background(), ip, 1)
	if len(ts) == 0 {
		return -1
	}
	return ts[0]
}

// FillQuickPing 并发（至多 8 路）给节点列表填 PingMS。
func FillQuickPing(nodes []Node) {
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := range nodes {
		wg.Add(1)
		sem <- struct{}{}
		go func(n *Node) {
			defer wg.Done()
			defer func() { <-sem }()
			n.PingMS = QuickPing(n.HostIP)
		}(&nodes[i])
	}
	wg.Wait()
}

// HasIPv6Internet 通过 Google / 阿里公共 DNS 的 v6 地址探测 IPv6 互联网连通性。
func HasIPv6Internet() bool {
	for _, target := range []string{"[2001:4860:4860::8888]:53", "[2400:3200::1]:53"} {
		if c, err := net.DialTimeout("tcp6", target, 2*time.Second); err == nil {
			_ = c.Close()
			return true
		}
	}
	return false
}
