package store

import (
	"encoding/json"
	"os"
	"path/filepath"

	"bandwidthquality/internal/engine"
)

// Settings 应用设置（设置页读写，JSON 文件存储）。
type Settings struct {
	Mode        string `json:"mode"`        // both | single | multi
	LengthS     int    `json:"lengthS"`     // 每阶段 5..13 秒
	DownThreads int    `json:"downThreads"` // 多线程下行连接数
	UpThreads   int    `json:"upThreads"`   // 多线程上行连接数
	Family      string `json:"family"`      // v4 | v6 | both
	IPv6        bool   `json:"ipv6"`        // 旧字段（已废弃）：仅用于迁移老配置到 Family
}

// DefaultSettings 默认设置：多线程、13 秒/阶段、16 下行/8 上行连接、IPv4+IPv6 双栈。
func DefaultSettings() Settings {
	return Settings{
		Mode:        engine.DefaultMode,
		LengthS:     engine.DefaultLengthS,
		DownThreads: engine.DefaultDownThreads,
		UpThreads:   engine.DefaultUpThreads,
		Family:      engine.FamilyBoth,
		IPv6:        true,
	}
}

func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "bandwidthquality")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// LoadSettings 读取设置，缺失/损坏时返回默认值。
func LoadSettings() (Settings, error) {
	s := DefaultSettings()
	p, err := settingsPath()
	if err != nil {
		return s, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return s, nil // 不存在 → 默认值
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return DefaultSettings(), err
	}
	s.Normalize()
	return s, nil
}

// SaveSettings 写入设置。
func SaveSettings(s Settings) error {
	s.Normalize()
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	p, err := settingsPath()
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

// Normalize 收敛非法值，并把旧配置的 ipv6 布尔迁移到 family。
func (s *Settings) Normalize() {
	if s.Mode != engine.ModeSingle && s.Mode != engine.ModeMulti && s.Mode != engine.ModeBoth {
		s.Mode = engine.DefaultMode
	}
	switch s.Family {
	case engine.FamilyV4, engine.FamilyV6, engine.FamilyBoth:
	default:
		if s.IPv6 {
			s.Family = engine.FamilyBoth
		} else {
			s.Family = engine.FamilyV4
		}
	}
	if s.LengthS <= 0 {
		s.LengthS = engine.DefaultLengthS
	}
	if s.LengthS < 5 {
		s.LengthS = 5
	}
	if s.LengthS > 13 {
		s.LengthS = 13
	}
	if s.DownThreads < 1 {
		s.DownThreads = engine.DefaultDownThreads
	}
	if s.DownThreads > 32 {
		s.DownThreads = 32
	}
	if s.UpThreads < 1 {
		s.UpThreads = engine.DefaultUpThreads
	}
	if s.UpThreads > 32 {
		s.UpThreads = 32
	}
	s.IPv6 = s.Family != engine.FamilyV4 // 保持旧字段与 family 一致
}

// ToOptions 应用设置 → 引擎参数（不填充 Node，选点由测速页决定）。
func (s Settings) ToOptions() engine.Options {
	s.Normalize()
	return engine.Options{
		Mode:        s.Mode,
		LengthS:     s.LengthS,
		DownThreads: s.DownThreads,
		UpThreads:   s.UpThreads,
		Family:      s.Family,
	}
}
