package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"bandwidthquality/internal/engine"
	"bandwidthquality/internal/store"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App Wails 绑定层：把 engine 的能力与事件桥接给前端。
type App struct {
	ctx     context.Context
	store   *store.Store
	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	s, err := store.Open()
	if err != nil {
		// 历史记录不可用不阻塞主功能
		wailsruntime.LogWarningf(ctx, "历史记录初始化失败: %v", err)
		return
	}
	a.store = s
}

// GetLocation 出口网络探测（IP/省/市/运营商）。
func (a *App) GetLocation() (engine.ClientLocation, error) {
	return engine.Probe(false)
}

// CheckIPv6 IPv6 互联网连通性。
func (a *App) CheckIPv6() bool {
	return engine.HasIPv6Internet()
}

// ListNodes 手动选点：候选节点列表（含快速 ping）。
func (a *App) ListNodes(opt engine.ListOptions) ([]engine.Node, error) {
	return engine.ListNodes(opt)
}

// PingNode 单节点时延/抖动测量。
func (a *App) PingNode(n engine.Node) (float64, float64) {
	return engine.PingNode(n)
}

// StartTest 阻塞执行一次完整测速；进度与采样经事件推送：
// bq:progress / bq:sample / bq:finished / bq:error。
func (a *App) StartTest(opts engine.Options) (*engine.TestResult, error) {
	a.mu.Lock()
	if a.running {
		a.mu.Unlock()
		return nil, fmt.Errorf("已有测速正在进行")
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.running = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.running = false
		a.mu.Unlock()
	}()

	cb := engine.Callbacks{
		OnProgress: func(p engine.Progress) {
			wailsruntime.EventsEmit(a.ctx, "bq:progress", p)
		},
		OnSample: func(s engine.Sample) {
			wailsruntime.EventsEmit(a.ctx, "bq:sample", s)
		},
	}
	res, err := engine.RunTest(ctx, opts, cb)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, context.Canceled) {
			msg = "测速已取消"
		}
		wailsruntime.EventsEmit(a.ctx, "bq:error", msg)
		return nil, err
	}
	// 全部地址族都没有产出（节点排队/列表全失败）→ 按失败处理，不写历史
	if !resultHasData(res) {
		msg := "测速失败"
		for _, f := range res.Families {
			if f.Error != "" {
				msg += "：" + f.Family + " " + f.Error
			}
		}
		wailsruntime.EventsEmit(a.ctx, "bq:error", msg)
		return nil, fmt.Errorf("%s", msg)
	}
	if a.store != nil {
		if serr := a.store.SaveTest(res); serr != nil {
			wailsruntime.LogWarningf(a.ctx, "历史保存失败: %v", serr)
		}
	}
	wailsruntime.EventsEmit(a.ctx, "bq:finished", res)
	return res, nil
}

// resultHasData 至少一个地址族测出了阶段数据。
func resultHasData(r *engine.TestResult) bool {
	for _, f := range r.Families {
		if len(f.Phases) > 0 {
			return true
		}
	}
	return false
}

// StopTest 取消当前测速。
func (a *App) StopTest() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.running && a.cancel != nil {
		a.cancel()
	}
}

// ---------- 历史记录 ----------

// ListHistory 最近的历史记录（每行 = 一次测速的一个地址族）。
func (a *App) ListHistory(limit int) ([]store.HistoryRow, error) {
	if a.store == nil {
		return nil, fmt.Errorf("历史记录不可用")
	}
	if limit <= 0 {
		limit = 100
	}
	return a.store.ListTests(limit)
}

// GetHistoryTest 单次测速的完整明细（含采样曲线）。
func (a *App) GetHistoryTest(testID string) (*engine.TestResult, error) {
	if a.store == nil {
		return nil, fmt.Errorf("历史记录不可用")
	}
	return a.store.GetTest(testID)
}

// DeleteHistory 删除一次测速。
func (a *App) DeleteHistory(testID string) error {
	if a.store == nil {
		return fmt.Errorf("历史记录不可用")
	}
	return a.store.DeleteTest(testID)
}

// ClearHistory 清空历史。
func (a *App) ClearHistory() error {
	if a.store == nil {
		return fmt.Errorf("历史记录不可用")
	}
	return a.store.Clear()
}

// ---------- 设置 ----------

// GetSettings 读取设置（缺失时返回默认值）。
func (a *App) GetSettings() (store.Settings, error) {
	return store.LoadSettings()
}

// SaveSettings 保存设置。
func (a *App) SaveSettings(s store.Settings) error {
	return store.SaveSettings(s)
}
