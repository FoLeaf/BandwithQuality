package engine

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
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
	_ [120]byte // Separate worker counters to avoid cache-line contention.
}

func (c *byteCounter) add(n int) { c.n.Add(int64(n)) }
func (c *byteCounter) snap() int64 {
	return c.n.Load()
}

const transferBufferSize = 256 << 10
const uploadContentLength int64 = 900000000

// One immutable random block shared by uploads; never generate entropy on the hot path.
var uploadPayload = sync.OnceValue(func() []byte {
	payload := make([]byte, transferBufferSize)
	if _, err := rand.Read(payload); err != nil {
		panic(err)
	}
	return payload
})

// lane 自愈参数：上游节点间歇性 RST/超时常见，单次失败就永久损失一条并行
// 连接会让相位后半程吞吐塌陷；按指数退避重试，连续失败才退役。
const (
	laneRetryBackoff = 250 * time.Millisecond
	laneMaxBackoff   = 2 * time.Second
	laneMaxFailures  = 3
)

// statusError 上游明确拒绝（非 2xx / 压缩编码）：相位内重试不会自愈。
type statusError struct{ msg string }

func (e *statusError) Error() string { return e.msg }

func isStatusError(err error) bool {
	var se *statusError
	return errors.As(err, &se)
}

// Cancellation closes blocked reads/writes immediately; the phase waits for all workers.
// down 决定放大哪个方向的 socket 缓冲（下行收、上行发），见 setSocketBuffer。
func dialTransfer(ctx context.Context, s Node, down bool) (net.Conn, func(), error) {
	d := net.Dialer{
		Timeout: 8 * time.Second,
		Control: func(_, _ string, raw syscall.RawConn) error {
			setSocketBuffer(raw, down)
			return nil
		},
	}
	c, err := d.DialContext(ctx, "tcp", hostPort(s.HostIP, s.Port))
	if err != nil {
		return nil, nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(deadline)
	}
	return c, func() { stop(); _ = c.Close() }, nil
}

// Refresh idle deadlines at most once per second, not once per 16 KiB syscall.
// Read and write deadlines are independent: upload responses may arrive only at EOF.
func refreshDeadline(c net.Conn, ctx context.Context, next *time.Time, down bool) {
	now := time.Now()
	if now.Before(*next) {
		return
	}
	deadline := now.Add(3 * time.Second)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	if down {
		_ = c.SetReadDeadline(deadline)
	} else {
		_ = c.SetWriteDeadline(deadline)
	}
	*next = now.Add(time.Second)
}

// Use net/http for fragmented headers and chunked/content-length framing, with a
// bounded header reader so a broken peer cannot grow header memory indefinitely.
func readTransferResponse(c net.Conn) (*http.Response, error) {
	limited := &io.LimitedReader{R: c, N: 64 << 10}
	resp, err := http.ReadResponse(bufio.NewReaderSize(limited, 32<<10), nil)
	limited.N = 1<<63 - 1
	return resp, err
}

// downloadWorker 一条下载 lane：完整文件读完立即续开请求占满相位；
// 传输错误按指数退避重试（上游间歇性 RST/超时不永久损失并行度），
// 上游明确拒绝或连续失败达上限后退役。
func downloadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	buf := make([]byte, transferBufferSize)
	failures := 0
	backoff := laneRetryBackoff
	for ctx.Err() == nil {
		n, err := downloadTransfer(ctx, s, uuid, counter, buf)
		if ctx.Err() != nil {
			return
		}
		if err == nil && n > 0 {
			failures, backoff = 0, laneRetryBackoff
			continue
		}
		if isStatusError(err) {
			return
		}
		failures++
		if failures >= laneMaxFailures {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, laneMaxBackoff)
	}
}

func downloadTransfer(ctx context.Context, s Node, uuid string, counter *byteCounter, buf []byte) (int64, error) {
	c, closeConn, err := dialTransfer(ctx, s, true)
	if err != nil {
		return 0, err
	}
	defer closeConn()
	addr := hostPort(s.HostIP, s.Port)
	// 上游 WAF 只认官方客户端的原始报文：r 必须是秒级时间戳、不允许出现
	// Accept-Encoding、Host 冒号后不能有空格——任何一处偏差都会被 403 拒绝。
	req := fmt.Sprintf("GET /speed/File(1G).dl?r=%d&key=%s HTTP/1.1\r\nAccept: */*\r\nConnection: close\r\nUser-Agent: %s\r\nHost:%s\r\n\r\n", time.Now().Unix(), uuid, uaBrowser, addr)
	var next time.Time
	refreshDeadline(c, ctx, &next, false)
	if _, err = io.WriteString(c, req); err != nil {
		return 0, err
	}
	next = time.Time{}
	refreshDeadline(c, ctx, &next, true)
	resp, err := readTransferResponse(c)
	if err != nil {
		return 0, err
	}
	// Close the connection before Body.Close on error; never drain an untrusted body.
	defer func() { _ = c.Close(); _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || (resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") {
		return 0, &statusError{fmt.Sprintf("invalid download response: %s", resp.Status)}
	}
	var total int64
	for ctx.Err() == nil {
		refreshDeadline(c, ctx, &next, true)
		n, err := resp.Body.Read(buf)
		counter.add(n)
		total += int64(n)
		if err == io.EOF {
			return total, nil
		}
		if err != nil {
			return total, err
		}
	}
	return total, ctx.Err()
}

// uploadWorker 一条上传 lane：请求完成续开；传输错误退避重试，
// 上游拒绝或连续失败达上限后退役（与 downloadWorker 同一套自愈策略）。
func uploadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	payload := uploadPayload()
	failures := 0
	backoff := laneRetryBackoff
	for ctx.Err() == nil {
		err := uploadTransfer(ctx, s, uuid, counter, payload, uploadContentLength)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			failures, backoff = 0, laneRetryBackoff
			continue
		}
		if isStatusError(err) {
			return
		}
		failures++
		if failures >= laneMaxFailures {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, laneMaxBackoff)
	}
}

// Keep the server's original 900 MB request size but honor its Content-Length,
// finish multipart framing, consume its status, then open the next request.
func uploadTransfer(ctx context.Context, s Node, uuid string, counter *byteCounter, payload []byte, contentLength int64) error {
	preamble := fmt.Sprintf("--%s\r\nContent-Disposition: form-data; name=\"upload\";filename=\"%s\"\r\n\r\n", boundary, time.Now().Format("SPEED_20060102_150405.000"))
	footer := "\r\n--" + boundary + "--\r\n"
	remaining := contentLength - int64(len(preamble)+len(footer))
	if remaining <= 0 || len(payload) == 0 {
		return fmt.Errorf("invalid upload body size")
	}
	c, closeConn, err := dialTransfer(ctx, s, false)
	if err != nil {
		return err
	}
	defer closeConn()
	// Read concurrently so an early rejection stops writes rather than being
	// misreported as throughput just because the local socket accepted bytes.
	response := make(chan struct{})
	var responseErr error
	go func() {
		resp, err := readTransferResponse(c)
		if err == nil && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
			err = &statusError{"upload rejected: " + resp.Status}
		}
		_ = c.Close()
		if resp != nil {
			_ = resp.Body.Close()
		}
		responseErr = err
		close(response)
	}()
	defer func() { _ = c.Close(); <-response }()
	header := fmt.Sprintf("POST /speed/doAnalsLoad.do HTTP/1.1\r\nConnection: close\r\nCache-Control: no-cache\r\nCharset: UTF-8\r\nKey: %s\r\nContent-Type: multipart/form-data;boundary=%s\r\nUser-Agent: %s\r\nHost: %s\r\nAccept-Encoding: gzip\r\nContent-Length: %d\r\n\r\n%s", uuid, boundary, uaUpload, hostPort(s.HostIP, s.Port), contentLength, preamble)
	var next time.Time
	refreshDeadline(c, ctx, &next, false)
	if _, err = io.WriteString(c, header); err != nil {
		return err
	}
	for remaining > 0 && ctx.Err() == nil {
		refreshDeadline(c, ctx, &next, false)
		size := min(int64(len(payload)), remaining)
		n, err := c.Write(payload[:int(size)])
		counter.add(n) // Payload only; no HTTP or multipart framing.
		remaining -= int64(n)
		if err != nil {
			if ctx.Err() != nil {
				return err
			}
			// 服务端拒绝并关闭时，写失败只是表象：先关连接解除阻塞的响应
			// 读取，再取真实原因，让 lane 立即退役而不是按瞬时错误退避重试。
			_ = c.Close()
			<-response
			if isStatusError(responseErr) {
				return responseErr
			}
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := io.WriteString(c, footer); err != nil {
		return err
	}
	// A completed body needs an acknowledgement before another request is started.
	// 主体完整送达后确认超时视为成功：字节已被对端接收，慢确认不应拖死健康 lane。
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	<-response
	if os.IsTimeout(responseErr) {
		return nil
	}
	return responseErr
}

// sustainedMbps 最终速率：剔除最慢 30% 的采样（预热爬坡残余与瞬时拥塞谷底），
// 对剩余最快的 70% 取均值。相比「最高 3 个采样均值」不再奖励单次瞬时突发，
// 更贴近可持续占用的带宽质量；采样不足 4 个时不剔除。
func sustainedMbps(speeds []float64) float64 {
	n := len(speeds)
	if n == 0 {
		return 0
	}
	cp := append([]float64(nil), speeds...)
	// 选择排序（交换最小值）：采样数很小（十几个），省去引入 sort 包的开销
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if cp[j] < cp[i] {
				cp[i], cp[j] = cp[j], cp[i]
			}
		}
	}
	drop := 0
	if n >= 4 {
		drop = max(1, n*3/10)
	}
	sum := 0.0
	for _, v := range cp[drop:] {
		sum += v
	}
	return sum / float64(n-drop)
}

// runPhase samples per-worker counters against actual monotonic time. All lanes
// start together; no traffic from a cancelled phase can leak into the next one.
func runPhase(ctx context.Context, s Node, uuid string, down bool, threads, lengthS, intervalMS int, onSample func(index, total int, speedMbps, elapsedS float64)) float64 {
	opts := Options{LengthS: lengthS, IntervalMS: intervalMS, DownThreads: threads, UpThreads: threads}
	opts.fill()
	lengthS, intervalMS, threads = opts.LengthS, opts.IntervalMS, opts.DownThreads
	interval := time.Duration(intervalMS) * time.Millisecond
	preheat := 2 * time.Second
	duration := time.Duration(lengthS) * time.Second
	start := time.Now()
	ctx, cancel := context.WithDeadline(ctx, start.Add(preheat+duration))
	counters := make([]byteCounter, threads)
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	for i := range counters {
		wg.Add(1)
		go func(counter *byteCounter) {
			defer wg.Done()
			if down {
				downloadWorker(ctx, s, uuid, counter)
			} else {
				uploadWorker(ctx, s, uuid, counter)
			}
		}(&counters[i])
	}
	points := max(1, int(duration/interval))
	samples := make([]float64, 0, points)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	lastTime := start
	var lastTotal, lastDelta int64
	var lastDuration time.Duration
	sample := func(now time.Time) {
		var total int64
		for i := range counters {
			total += counters[i].snap()
		}
		delta := total - lastTotal
		elapsed := now.Sub(lastTime)
		speed := calcMbps(lastDelta+delta, float64(lastDuration+elapsed)/float64(time.Millisecond))
		lastTotal, lastDelta, lastDuration, lastTime = total, delta, elapsed, now
		if now.Sub(start) < preheat+interval || len(samples) >= points {
			return
		}
		samples = append(samples, speed)
		if onSample != nil {
			// Keep zero-based graph timestamps while using real elapsed time for rates.
			measured := max(0, now.Sub(start)-preheat-interval)
			onSample(len(samples)-1, points, speed, measured.Seconds())
		}
	}
	for {
		select {
		case <-ctx.Done():
			// Include the final interval (ticker and deadline can become ready together).
			if ctx.Err() == context.DeadlineExceeded && time.Since(lastTime) >= interval/2 {
				sample(time.Now())
			}
			return sustainedMbps(samples)
		case <-ticker.C:
			sample(time.Now())
		}
	}
}
