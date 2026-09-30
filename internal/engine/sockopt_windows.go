//go:build windows

package engine

import "syscall"

// socketBufferBytes 数据面 socket 收/发缓冲目标值（4 MiB）。
// Windows 默认 SO_SNDBUF 仅 64KB、发送侧自动调优保守，接收窗口自动调优
// 爬坡以秒计；13 秒的短相位里不放大缓冲，跨省高时延路径（BDP 大）的
// 单连接吞吐会被钉死在低位。显式调大可即刻放开单连接窗口上限。
const socketBufferBytes = 4 << 20

// setSocketBuffer 建连前调整缓冲（尽力而为，失败静默回退系统默认）：
// 下行放大接收缓冲（该 socket 的窗口自动调优随之关闭，换取即时大窗口），
// 上行放大发送缓冲。仅作用于数据面测速连接，不碰系统全局 TCP 参数。
func setSocketBuffer(c syscall.RawConn, down bool) {
	opt := syscall.SO_SNDBUF
	if down {
		opt = syscall.SO_RCVBUF
	}
	_ = c.Control(func(fd uintptr) {
		_ = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, opt, socketBufferBytes)
	})
}
