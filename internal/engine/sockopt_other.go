//go:build !windows

package engine

import "syscall"

// setSocketBuffer 非 Windows 平台为 no-op：Linux 的 tcp_moderate_rcvbuf /
// 发送缓冲自动调优成熟且上限宽松，显式固定缓冲反而会关闭自动调优
// （并被 rmem_max/wmem_max 钳制，可能低于自动调优能达到的值）。
func setSocketBuffer(syscall.RawConn, bool) {}
