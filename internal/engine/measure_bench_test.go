package engine

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func testNode(raw string) Node {
	host, port, _ := net.SplitHostPort(raw)
	p, _ := strconv.Atoi(port)
	return Node{HostIP: host, Port: p}
}

// Loopback only: report receiver bytes, not bytes queued in the sender socket.
func BenchmarkUploadWorker(b *testing.B) { benchmarkUpload(b, uploadWorker) }

func benchmarkUpload(b *testing.B, worker func(context.Context, Node, string, *byteCounter)) {
	var received atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 256<<10)
		for {
			n, err := r.Body.Read(buf)
			received.Add(int64(n))
			if err != nil {
				break
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	node := testNode(server.Listener.Addr().String())
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		var counter byteCounter
		worker(ctx, node, "benchmark", &counter)
		cancel()
	}
	b.StopTimer()
	b.ReportMetric(float64(received.Load())*8/b.Elapsed().Seconds()/1e6, "receiver-Mbps")
}
