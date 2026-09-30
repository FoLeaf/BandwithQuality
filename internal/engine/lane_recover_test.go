package engine

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 上游间歇性 RST/半途断流不应永久损失并行度：lane 要退避重试，
// 两个连接收到的字节都计入吞吐。
func TestDownloadWorkerRetriesTransientFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var requests atomic.Int64
	go func() {
		for i := 0; ; i++ {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			requests.Add(1)
			go func(i int, c net.Conn) {
				defer c.Close()
				_, _ = bufio.NewReader(c).ReadString('\n')
				switch i {
				case 0: // 声明 100 字节只送 40 字节就断流（瞬时错误）
					_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"+string(make([]byte, 40)))
				case 1: // 完整响应（自愈成功）
					_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789")
				default: // 第三个请求：取消相位，worker 退出
					cancel()
				}
			}(i, c)
		}
	}()
	var counter byteCounter
	done := make(chan struct{})
	go func() {
		defer close(done)
		downloadWorker(ctx, testNode(ln.Addr().String()), "test", &counter)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("worker 未在重试后退出")
	}
	if got := counter.snap(); got != 50 {
		t.Fatalf("计数=%d，应为 40+10=50", got)
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("请求数=%d，应为 3（断流重试 + 续开 + 取消）", got)
	}
}

// 上游明确拒绝（403 等）相位内不会自愈，lane 必须立即退役而不是浪费退避重试。
func TestLaneRetiresImmediatelyOnUpstreamStatus(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var counter byteCounter
	start := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		downloadWorker(ctx, testNode(server.Listener.Addr().String()), "test", &counter)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("lane 未在拒绝后立即退役")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("退役耗时 %v，不应包含退避等待", elapsed)
	}
	if requests.Load() != 1 {
		t.Fatalf("请求数=%d，拒绝后不应重试", requests.Load())
	}
}

// 服务端拒绝导致的写失败必须归因为 statusError：lane 立即退役，
// 而不是被当成瞬时传输错误反复重试。
func TestUploadWriteErrorSurfacesStatusError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = bufio.NewReader(c).ReadString('\n')
		_, _ = io.WriteString(c, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
		_, _ = io.Copy(io.Discard, c)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var counter byteCounter
	start := time.Now()
	err = uploadTransfer(ctx, testNode(ln.Addr().String()), "test", &counter, uploadPayload(), uploadContentLength)
	if !isStatusError(err) {
		t.Fatalf("应归因为上游拒绝，实际 err=%v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("拒绝未及时停止上传")
	}
	<-serverDone
}

// 900 MB 主体完整送达后，服务端确认慢于 3 秒不应判为失败：
// 字节已被接收，慢确认不该拖死这条健康的 lane。
func TestUploadAckTimeoutCountsAsSuccess(t *testing.T) {
	received := make(chan int64, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received <- n
		// 不写任何响应：客户端确认读取将在 3 秒读超时后解除
		<-r.Context().Done() // 客户端确认超时返回后关连接，此处解除阻塞，让 server.Close() 得以完成
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var counter byteCounter
	start := time.Now()
	err := uploadTransfer(ctx, testNode(server.Listener.Addr().String()), "test", &counter, uploadPayload(), uploadContentLength)
	if err != nil {
		t.Fatalf("确认超时不应判为失败: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 3*time.Second {
		t.Fatalf("确认等待不足 3 秒即返回: %v", elapsed)
	}
	if got := <-received; got != uploadContentLength {
		t.Fatalf("服务端收到 %d 字节，应为 %d", got, uploadContentLength)
	}
}
