//go:build windows

package engine

import (
	"context"
	"net"
	"syscall"
	"testing"
	"time"
)

// 数据面连接必须带上调大的收/发缓冲：Windows 默认 64KB 发送缓冲与爬坡缓慢的
// 接收窗口自动调优是短相位高时延路径的主要单连接瓶颈。
func TestDialTransferTunesSocketBuffers(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, down := range []bool{true, false} {
		name, opt := "SO_SNDBUF", syscall.SO_SNDBUF
		if down {
			name, opt = "SO_RCVBUF", syscall.SO_RCVBUF
		}
		c, closeConn, err := dialTransfer(ctx, testNode(ln.Addr().String()), down)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := c.(*net.TCPConn).SyscallConn()
		if err != nil {
			t.Fatal(err)
		}
		var got int
		_ = raw.Control(func(fd uintptr) {
			got, _ = syscall.GetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, opt)
		})
		closeConn()
		if got < 1<<20 {
			t.Fatalf("%s = %d，应至少放大到 1 MiB", name, got)
		}
	}
}
