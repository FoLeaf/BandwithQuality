//go:build windows

package engine

import "syscall"

// CREATE_NO_WINDOW：GUI 进程调用控制台子程序（ping）时不创建新控制台窗口，
// 消除测速/连通性测试时的黑框闪烁。
const createNoWindow = 0x08000000

func sysProcAttrNoWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
