package engine

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDownloadFramingAndRollover(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		t.Run(fmt.Sprint("chunked=", chunked), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var calls atomic.Int64
			const body = "payload-not-http-framing"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) > 3 {
					cancel()
					return
				}
				if chunked {
					w.(http.Flusher).Flush()
				} else {
					w.Header().Set("Content-Length", fmt.Sprint(len(body)))
				}
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()
			var counter byteCounter
			downloadWorker(ctx, testNode(server.Listener.Addr().String()), "test", &counter)
			if calls.Load() != 4 || counter.snap() != 3*int64(len(body)) {
				t.Fatalf("calls=%d payload=%d", calls.Load(), counter.snap())
			}
		})
	}
}

func TestDownloadRejectsHTTPError(t *testing.T) {
	for _, status := range []int{302, 403, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = io.WriteString(w, "not speed data")
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var counter byteCounter
			downloadWorker(ctx, testNode(server.Listener.Addr().String()), "test", &counter)
			if counter.snap() != 0 {
				t.Fatalf("counted HTTP error: %d", counter.snap())
			}
		})
	}
}

func TestUploadContentLengthAndMultipart(t *testing.T) {
	const size int64 = 1 << 20
	payload := []byte(strings.Repeat("0123456789abcdef", 4096))
	received := make(chan int64, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != size {
			t.Errorf("Content-Length=%d", r.ContentLength)
		}
		reader, err := r.MultipartReader()
		if err != nil {
			t.Error(err)
			return
		}
		part, err := reader.NextPart()
		if err != nil {
			t.Error(err)
			return
		}
		if part.FormName() != "upload" {
			t.Errorf("form name=%s", part.FormName())
		}
		data, err := io.ReadAll(part)
		if err != nil {
			t.Error(err)
			return
		}
		for i, v := range data {
			if v != payload[i%len(payload)] {
				t.Error("corrupt payload")
				break
			}
		}
		if _, err = reader.NextPart(); err != io.EOF {
			t.Errorf("missing final boundary: %v", err)
		}
		received <- int64(len(data))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var counter byteCounter
	node := testNode(server.Listener.Addr().String())
	// Repeat on the same node to verify completed requests can replenish a lane.
	for i := 0; i < 2; i++ {
		before := counter.snap()
		if err := uploadTransfer(ctx, node, "test", &counter, payload, size); err != nil {
			t.Fatal(err)
		}
		if got := <-received; counter.snap()-before != got {
			t.Fatalf("counter includes framing: sent=%d received=%d", counter.snap()-before, got)
		}
	}
}

func TestWorkersCancelBlockedIO(t *testing.T) {
	for _, down := range []bool{true, false} {
		t.Run(fmt.Sprint("down=", down), func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			accepted := make(chan net.Conn, 1)
			go func() {
				c, err := ln.Accept()
				if err == nil {
					accepted <- c
				}
			}()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			var counter byteCounter
			go func() {
				defer close(done)
				if down {
					downloadWorker(ctx, testNode(ln.Addr().String()), "test", &counter)
				} else {
					uploadWorker(ctx, testNode(ln.Addr().String()), "test", &counter)
				}
			}()
			c := <-accepted
			defer c.Close()
			time.Sleep(30 * time.Millisecond)
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("worker remained blocked after cancellation")
			}
			before := counter.snap()
			time.Sleep(20 * time.Millisecond)
			if counter.snap() != before {
				t.Fatal("traffic continued after worker exit")
			}
		})
	}
}

func TestUploadEarlyRejection(t *testing.T) {
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
		_, _ = http.ReadRequest(bufio.NewReader(c))
		_, _ = io.WriteString(c, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
		_, _ = io.Copy(io.Discard, c)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var counter byteCounter
	start := time.Now()
	err = uploadTransfer(ctx, testNode(ln.Addr().String()), "test", &counter, uploadPayload(), uploadContentLength)
	if err == nil {
		t.Fatal("early rejection accepted")
	}
	if time.Since(start) > time.Second {
		t.Fatal("did not stop on early response")
	}
	<-serverDone
}

func TestTransferResponseBoundedHeaders(t *testing.T) {
	c, s := net.Pipe()
	defer c.Close()
	go func() {
		defer s.Close()
		_, _ = io.WriteString(s, "HTTP/1.1 200 OK\r\nX-Large: "+strings.Repeat("x", 128<<10)+"\r\n\r\n")
	}()
	if _, err := readTransferResponse(c); err == nil {
		t.Fatal("accepted oversized headers")
	}
}

func TestPhaseCancellationJoinsWorkers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	start := time.Now()
	runPhase(ctx, testNode(server.Listener.Addr().String()), "test", true, 32, 5, 100, nil)
	if time.Since(start) > time.Second {
		t.Fatal("phase startup/cancellation delayed by connection staggering")
	}
}

func TestOptionsResourceBounds(t *testing.T) {
	opts := Options{DownThreads: 1000000, UpThreads: 1000000, IntervalMS: 1000000}
	opts.fill()
	if opts.DownThreads != 32 || opts.UpThreads != 32 || opts.IntervalMS != 1000 {
		t.Fatalf("unbounded options: %+v", opts)
	}
}

// Slow callbacks used to inflate Mbps by dividing bytes by the nominal tick.
func TestPhaseUsesActualElapsedTime(t *testing.T) {
	const chunkSize = 32 << 10
	const pacing = 20 * time.Millisecond
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tick := time.NewTicker(pacing)
		defer tick.Stop()
		data := make([]byte, chunkSize)
		for {
			select {
			case <-r.Context().Done():
				return
			case <-tick.C:
				if _, err := w.Write(data); err != nil {
					return
				}
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var samples []float64
	runPhase(ctx, testNode(server.Listener.Addr().String()), "test", true, 1, 5, 100, func(index, total int, speed, elapsed float64) {
		samples = append(samples, speed)
		time.Sleep(220 * time.Millisecond)
	})
	if len(samples) < 10 {
		t.Fatalf("too few samples: %d", len(samples))
	}
	var sum float64
	for _, v := range samples[2 : len(samples)-1] {
		sum += v
	}
	mean := sum / float64(len(samples)-3)
	expected := float64(chunkSize) * 8 / pacing.Seconds() / 1e6
	if mean < expected*0.7 || mean > expected*1.3 {
		t.Fatalf("Mbps=%f expected near %f", mean, expected)
	}
}

func TestTransferResponseFragmentedHeaders(t *testing.T) {
	for _, raw := range []string{
		"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\n\r\nHELLO",
		"HTTP/1.1 200 OK\r\nno terminator",
		"garbage\r\n\r\n",
	} {
		t.Run(raw[:7], func(t *testing.T) {
			c, s := net.Pipe()
			defer c.Close()
			go func() {
				defer s.Close()
				for _, v := range []byte(raw) {
					if _, err := s.Write([]byte{v}); err != nil {
						return
					}
				}
			}()
			resp, err := readTransferResponse(c)
			if !strings.HasPrefix(raw, "HTTP/1.1 206") {
				if err == nil {
					t.Fatal("malformed response accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(resp.Body)
			if err != nil || resp.StatusCode != 206 || string(body) != "HELLO" {
				t.Fatalf("response=%v body=%q err=%v", resp.Status, body, err)
			}
		})
	}
}
