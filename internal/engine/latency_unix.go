//go:build !windows

package engine

import "syscall"

func sysProcAttrNoWindow() *syscall.SysProcAttr {
	return nil
}
