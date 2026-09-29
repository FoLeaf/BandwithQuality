package engine

import (
	"bufio"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"net/http"
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

// Cancellation closes blocked reads/writes immediately; the phase waits for all workers.
func dialTransfer(ctx context.Context, s Node) (net.Conn, func(), error) {
	d := net.Dialer{Timeout: 8 * time.Second}
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

// Reopen a completed finite file for the remaining phase rather than losing a lane.
func downloadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	buf := make([]byte, transferBufferSize)
	for ctx.Err() == nil {
		n, err := downloadTransfer(ctx, s, uuid, counter, buf)
		if err != nil || n == 0 {
			return
		}
	}
}

func downloadTransfer(ctx context.Context, s Node, uuid string, counter *byteCounter, buf []byte) (int64, error) {
	c, closeConn, err := dialTransfer(ctx, s)
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
		return 0, fmt.Errorf("invalid download response: %s", resp.Status)
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

func uploadWorker(ctx context.Context, s Node, uuid string, counter *byteCounter) {
	payload := uploadPayload()
	for ctx.Err() == nil {
		if err := uploadTransfer(ctx, s, uuid, counter, payload, uploadContentLength); err != nil {
			return
		}
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
	c, closeConn, err := dialTransfer(ctx, s)
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
			err = fmt.Errorf("upload rejected: %s", resp.Status)
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
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	<-response
	return responseErr
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
			return avgTop3(samples)
		case <-ticker.C:
			sample(time.Now())
		}
	}
}
