package engine

import (
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// calcMbps 字节→Mbps。
func calcMbps(nbytes int64, durationMS float64) float64 {
	if durationMS <= 0 {
		return 0
	}
	return ((float64(nbytes) * 8) / 1000.0 / 1000.0) / (durationMS / 1000.0)
}

type byteCounter struct {
	n atomic.Int64
}

func (c *byteCounter) add(n int) { c.n.Add(int64(n)) }
func (c *byteCounter) snap() int64 {
	return c.n.Load()
}

// parseHTTPHeader 从裸 TCP 读到的首块数据里找 HTTP 响应头边界。
func parseHTTPHeader(buf []byte) (code int, bodyOff int, ok bool) {
	idx := indexDoubleCRLF(buf)
	if idx < 0 {
		return 0, 0, false
	}
	first := firstLine(buf[:idx])
	if !hasHTTP11Prefix(first) {
		return 0, 0, false
	}
	code = statusCode(first)
	return code, idx + 4, true
}

func indexDoubleCRLF(buf []byte) int {
	for i := 0; i+3 < len(buf); i++ {
		if buf[i] == '\r' && buf[i+1] == '\n' && buf[i+2] == '\r' && buf[i+3] == '\n' {
			return i
		}
	}
	return -1
}

func firstLine(buf []byte) string {
	for i, b := range buf {
		if b == '\r' || b == '\n' {
			return string(buf[:i])
		}
	}
	return string(buf)
}

func hasHTTP11Prefix(line string) bool {
	return len(line) >= 7 && line[0] == 'H' && line[1] == 'T' && line[2] == 'T' && line[3] == 'P' &&
		line[4] == '/' && line[5] == '1' && line[6] == '.'
}

func statusCode(firstLine string) int {
	fs := splitFields(firstLine)
	if len(fs) < 2 {
		return 0
	}
	code := 0
	for _, r := range fs[1] {
		if r < '0' || r > '9' {
			break
		}
		code = code*10 + int(r-'0')
	}
	return code
}

func splitFields(s string) []string {
	var out []string
	start := -1
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ' ' || s[i] == '\t' {
			if start >= 0 {
				out = append(out, s[start:i])
				start = -1
			}
		} else if start < 0 {
			start = i
		}
	}
	return out
}

// downloadWorker 裸 TCP 下载：GET /speed/File(1G).dl，64KB 读缓冲，
// 连接级 30s 截止 + 单读 3s 截止，字节计入 counter。
func downloadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	addr := hostPort(s.HostIP, s.Port)
	path := fmt.Sprintf("/speed/File(1G).dl?r=%d&key=%s", time.Now().Unix(), uuid)
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nAccept: */*\r\nConnection: close\r\nUser-Agent: %s\r\nHost:%s\r\n\r\n",
		path, uaBrowser, addr)
	c, err := net.DialTimeout("tcp", addr, 8*time.Second)
	if err != nil {
		return
	}
	defer c.Close()
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := c.Write([]byte(req)); err != nil {
		return
	}
	buf := make([]byte, 0, 8192)
	tmp := make([]byte, 65536)
	headerDone := false
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, err := c.Read(tmp)
		if n > 0 {
			if !headerDone {
				buf = append(buf, tmp[:n]...)
				code, off, ok := parseHTTPHeader(buf)
				if !ok {
					if err != nil {
						return
					}
					continue
				}
				if code < 200 || code >= 400 {
					return
				}
				if len(buf) > off {
					counter.add(len(buf) - off)
				}
				headerDone = true
				buf = nil
			} else {
				counter.add(n)
			}
		}
		if err != nil {
			return
		}
	}
}

// uploadWorker 裸 TCP 上传：POST multipart 谎报 Content-Length 循环写 16KB 随机块。
func uploadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	addr := hostPort(s.HostIP, s.Port)
	fn := time.Now().Format("SPEED_20060102_150405.000")
	header := fmt.Sprintf(
		"POST /speed/doAnalsLoad.do HTTP/1.1\r\nConnection: close\r\nCache-Control: no-cache\r\nCharset: UTF-8\r\nKey: %s\r\nContent-Type: multipart/form-data;boundary=%s\r\nUser-Agent: %s\r\nHost: %s\r\nAccept-Encoding: gzip\r\nContent-Length: 900000000\r\n\r\n--%s\r\nContent-Disposition: form-data; name=\"upload\";filename=\"%s\"\r\n\r\n",
		uuid, boundary, uaUpload, addr, boundary, fn,
	)
	payload := make([]byte, 16384)
	_, _ = rand.Read(payload)
	c, err := net.DialTimeout("tcp", addr, 8*time.Second)
	if err != nil {
		return
	}
	defer c.Close()
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	n, err := c.Write([]byte(header))
	if err != nil {
		return
	}
	counter.add(n)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_ = c.SetWriteDeadline(time.Now().Add(3 * time.Second))
		n, err := c.Write(payload)
		if n > 0 {
			counter.add(n)
		}
		if err != nil {
			return
		}
	}
}

// avgTop3 取最高的至多 3 个采样点的均值 —— 官方口径的最终速率。
func avgTop3(speeds []float64) float64 {
	if len(speeds) == 0 {
		return 0
	}
	cp := append([]float64(nil), speeds...)
	// 插入排序：采样数很小（十几个），且避免引入 sort 的额外拷贝
	for i := 0; i < len(cp); i++ {
		for j := i + 1; j < len(cp); j++ {
			if cp[j] < cp[i] {
				cp[i], cp[j] = cp[j], cp[i]
			}
		}
	}
	n := 3
	if len(cp) < n {
		n = len(cp)
	}
	sum := 0.0
	for _, v := range cp[len(cp)-n:] {
		sum += v
	}
	return sum / float64(n)
}

// runPhase 跑一个方向/线程数的测速阶段：
// 500ms tick 采样，跳过前 2s 预热，avgTop3 平滑；
// 每个计入的 tick 通过 onSample 推送瞬时速率（窗口平滑值，与最终口径一致）。
func runPhase(ctx context.Context, s Node, uuid string, down bool, threads, lengthS, intervalMS int, onSample func(index, total int, speedMbps, elapsedS float64)) float64 {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var counter byteCounter
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if down {
				downloadWorker(ctx, s, uuid, &counter)
			} else {
				uploadWorker(ctx, s, uuid, &counter)
			}
		}()
		time.Sleep(40 * time.Millisecond)
	}
	points := (lengthS * 1000) / intervalMS
	if points < 1 {
		points = 1
	}
	preheat := 2000 / intervalMS
	if preheat < 1 {
		preheat = 1
	}
	var lastDelta, lastTotal int64
	var samples []float64
	ticker := time.NewTicker(time.Duration(intervalMS) * time.Millisecond)
	defer ticker.Stop()
	measured := 0
	for index := 1; index <= points+preheat; index++ {
		select {
		case <-ctx.Done():
			cancel()
			return avgTop3(samples)
		case <-ticker.C:
		}
		total := counter.snap()
		delta := total - lastTotal
		if delta < 0 {
			delta = 0
		}
		lastTotal = total
		var speed float64
		if lastDelta > 0 {
			speed = calcMbps(lastDelta+delta, float64(intervalMS*2))
		} else {
			speed = calcMbps(delta, float64(intervalMS))
		}
		lastDelta = delta
		if index > preheat {
			if onSample != nil {
				onSample(measured, points, speed, float64(measured*intervalMS)/1000.0)
			}
			measured++
			samples = append(samples, speed)
		}
	}
	cancel()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
	}
	return avgTop3(samples)
}
