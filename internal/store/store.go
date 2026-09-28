// Package store 历史记录与设置的持久化：SQLite（modernc.org/sqlite，纯 Go 无 cgo）。
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"bandwidthquality/internal/engine"
)

// HistoryRow 历史列表一行：一次测速 × 一个地址族。
type HistoryRow struct {
	TestID     string    `json:"testId"`
	StartedAt  time.Time `json:"startedAt"`
	Family     string    `json:"family"`
	NodeName   string    `json:"nodeName"`
	NodeIP     string    `json:"nodeIp"`
	Province   string    `json:"province"`
	City       string    `json:"city"`
	Oper       string    `json:"oper"`
	LatencyMS  float64   `json:"latencyMs"`
	JitterMS   float64   `json:"jitterMs"`
	SingleDown float64   `json:"singleDown"`
	SingleUp   float64   `json:"singleUp"`
	MultiDown  float64   `json:"multiDown"`
	MultiUp    float64   `json:"multiUp"`
	DurationS  float64   `json:"durationS"`
}

// Store SQLite 存储句柄。
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS history (
	test_id      TEXT NOT NULL,
	started_at   TEXT NOT NULL,
	family       TEXT NOT NULL,
	node_name    TEXT,
	node_ip      TEXT,
	province     TEXT,
	city         TEXT,
	oper         TEXT,
	latency_ms   REAL,
	jitter_ms    REAL,
	single_down  REAL,
	single_up    REAL,
	multi_down   REAL,
	multi_up     REAL,
	duration_s   REAL,
	samples_json TEXT,
	PRIMARY KEY (test_id, family)
);
CREATE INDEX IF NOT EXISTS idx_history_started ON history(started_at DESC);
`

func dbPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "bandwidthquality")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "history.db"), nil
}

// Open 打开（必要时创建）历史库。
func Open() (*Store, error) {
	p, err := dbPath()
	if err != nil {
		return nil, err
	}
	return OpenAt(p)
}

// OpenAt 按指定路径打开数据库（单测注入用）。
func OpenAt(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close 关闭数据库。
func (s *Store) Close() error {
	return s.db.Close()
}

// SaveTest 一次测速的每个地址族写一行。
func (s *Store) SaveTest(r *engine.TestResult) error {
	if s == nil {
		return fmt.Errorf("store 未初始化")
	}
	testID := fmt.Sprintf("t%d", r.StartedAt.UnixNano())
	started := r.StartedAt.Format(time.RFC3339)
	for _, f := range r.Families {
		samplesJSON, err := json.Marshal(f.Samples)
		if err != nil {
			return err
		}
		nodeName, nodeIP := "", ""
		if f.Node != nil {
			nodeName = f.Node.DisplayName()
			nodeIP = f.Node.HostIP
		}
		_, err = s.db.Exec(
			`INSERT OR REPLACE INTO history
			 (test_id, started_at, family, node_name, node_ip, province, city, oper,
			  latency_ms, jitter_ms, single_down, single_up, multi_down, multi_up, duration_s, samples_json)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			testID, started, f.Family, nodeName, nodeIP, r.Client.Province, r.Client.City, r.Client.Oper,
			f.LatencyMS, f.JitterMS,
			f.PhaseMbps(engine.PhaseDownSingle), f.PhaseMbps(engine.PhaseUpSingle),
			f.PhaseMbps(engine.PhaseDownMulti), f.PhaseMbps(engine.PhaseUpMulti),
			r.DurationS, string(samplesJSON),
		)
		if err != nil {
			return err
		}
	}
	return nil
}

const rowCols = `test_id, started_at, family, node_name, node_ip, province, city, oper,
 latency_ms, jitter_ms, single_down, single_up, multi_down, multi_up, duration_s`

func scanRow(sc interface{ Scan(...any) error }) (HistoryRow, error) {
	var r HistoryRow
	var started string
	err := sc.Scan(&r.TestID, &started, &r.Family, &r.NodeName, &r.NodeIP, &r.Province, &r.City, &r.Oper,
		&r.LatencyMS, &r.JitterMS, &r.SingleDown, &r.SingleUp, &r.MultiDown, &r.MultiUp, &r.DurationS)
	if err != nil {
		return r, err
	}
	if t, e := time.Parse(time.RFC3339, started); e == nil {
		r.StartedAt = t
	}
	return r, nil
}

// ListTests 最近 limit 次测速，按时间倒序。
func (s *Store) ListTests(limit int) ([]HistoryRow, error) {
	rows, err := s.db.Query(`SELECT `+rowCols+` FROM history ORDER BY started_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryRow
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetTest 单次测速完整明细（含每族采样曲线），还原为 engine.TestResult。
func (s *Store) GetTest(testID string) (*engine.TestResult, error) {
	rows, err := s.db.Query(
		`SELECT `+rowCols+`, samples_json FROM history WHERE test_id = ? ORDER BY family`, testID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &engine.TestResult{}
	seen := false
	for rows.Next() {
		var r HistoryRow
		var started, samplesJSON string
		if err := rows.Scan(&r.TestID, &started, &r.Family, &r.NodeName, &r.NodeIP, &r.Province, &r.City, &r.Oper,
			&r.LatencyMS, &r.JitterMS, &r.SingleDown, &r.SingleUp, &r.MultiDown, &r.MultiUp, &r.DurationS,
			&samplesJSON); err != nil {
			return nil, err
		}
		if t, e := time.Parse(time.RFC3339, started); e == nil {
			r.StartedAt = t
		}
		if !seen {
			seen = true
			res.Client = engine.ClientLocation{Province: r.Province, City: r.City, Oper: r.Oper}
			res.DurationS = r.DurationS
			res.StartedAt = r.StartedAt
		}
		f := engine.FamilyResult{
			Family:    r.Family,
			LatencyMS: r.LatencyMS,
			JitterMS:  r.JitterMS,
			Phases:    phasesOf(r),
		}
		if r.NodeName != "" || r.NodeIP != "" {
			f.Node = &engine.Node{HostName: r.NodeName, HostIP: r.NodeIP}
		}
		if samplesJSON != "" {
			_ = json.Unmarshal([]byte(samplesJSON), &f.Samples)
		}
		res.Families = append(res.Families, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !seen {
		return nil, fmt.Errorf("记录不存在")
	}
	return res, nil
}

// phasesOf 由扁平列还原阶段速率（-1 表示未测，不生成阶段项）。
func phasesOf(r HistoryRow) []engine.PhaseResult {
	var out []engine.PhaseResult
	add := func(phase string, v float64) {
		if v >= 0 {
			out = append(out, engine.PhaseResult{Phase: phase, Mbps: v})
		}
	}
	add(engine.PhaseDownSingle, r.SingleDown)
	add(engine.PhaseUpSingle, r.SingleUp)
	add(engine.PhaseDownMulti, r.MultiDown)
	add(engine.PhaseUpMulti, r.MultiUp)
	return out
}

// DeleteTest 删除一次测速（全部地址族）。
func (s *Store) DeleteTest(testID string) error {
	_, err := s.db.Exec(`DELETE FROM history WHERE test_id = ?`, testID)
	return err
}

// Clear 清空全部历史。
func (s *Store) Clear() error {
	_, err := s.db.Exec(`DELETE FROM history`)
	return err
}
