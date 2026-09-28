package store

import (
	"path/filepath"
	"testing"
	"time"

	"bandwidthquality/internal/engine"
)

func testResult(t *testing.T, at time.Time) *engine.TestResult {
	t.Helper()
	return &engine.TestResult{
		Client:    engine.ClientLocation{IP: "111.22.33.44", Province: "湖北", City: "武汉", Oper: "电信"},
		StartedAt: at,
		DurationS: 36.5,
		Families: []engine.FamilyResult{
			{
				Family: engine.FamilyIPv4,
				Node:   &engine.Node{HostName: "湖北武汉电信", HostIP: "111.22.33.1", Port: 8080, City: "武汉", Oper: "电信"},
				LatencyMS: 12.5, JitterMS: 1.2,
				Phases: []engine.PhaseResult{
					{Phase: engine.PhaseDownSingle, Mbps: 321.5},
					{Phase: engine.PhaseUpSingle, Mbps: 88.2},
					{Phase: engine.PhaseDownMulti, Mbps: 940.1},
					{Phase: engine.PhaseUpMulti, Mbps: 93.7},
				},
				Samples: []engine.Sample{
					{Family: engine.FamilyIPv4, Phase: engine.PhaseDownSingle, Index: 0, ElapsedS: 0, SpeedMbps: 100},
					{Family: engine.FamilyIPv4, Phase: engine.PhaseDownSingle, Index: 1, ElapsedS: 0.5, SpeedMbps: 300},
				},
			},
		},
	}
}

func TestSaveListGetDelete(t *testing.T) {
	s, err := OpenAt(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.Local)
	if err := s.SaveTest(testResult(t, at)); err != nil {
		t.Fatal(err)
	}
	// 同一测试重复保存应幂等
	if err := s.SaveTest(testResult(t, at)); err != nil {
		t.Fatal(err)
	}

	rows, err := s.ListTests(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("应 1 行，got %d", len(rows))
	}
	r := rows[0]
	if r.Family != engine.FamilyIPv4 || r.SingleDown != 321.5 || r.MultiUp != 93.7 ||
		r.Province != "湖北" || r.NodeName != "武汉电信" {
		t.Errorf("行字段不对: %+v", r)
	}

	detail, err := s.GetTest(r.TestID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Client.City != "武汉" || len(detail.Families) != 1 {
		t.Fatalf("明细不对: %+v", detail)
	}
	f := detail.Families[0]
	if f.PhaseMbps(engine.PhaseDownSingle) != 321.5 || len(f.Samples) != 2 {
		t.Errorf("明细阶段/采样不对: %+v", f)
	}
	if f.Node == nil || f.Node.HostIP != "111.22.33.1" {
		t.Errorf("明细节点不对: %+v", f.Node)
	}

	if err := s.DeleteTest(r.TestID); err != nil {
		t.Fatal(err)
	}
	rows, _ = s.ListTests(10)
	if len(rows) != 0 {
		t.Fatalf("删除后应 0 行，got %d", len(rows))
	}
	if _, err := s.GetTest(r.TestID); err == nil {
		t.Error("删除后 GetTest 应报错")
	}

	// 失败轮（Node=nil，有 Error）也应可存取
	res := testResult(t, at.Add(time.Minute))
	res.Families = append(res.Families, engine.FamilyResult{Family: engine.FamilyIPv6, Error: "无可用节点", LatencyMS: -1})
	if err := s.SaveTest(res); err != nil {
		t.Fatal(err)
	}
	rows, _ = s.ListTests(10)
	if len(rows) != 2 {
		t.Fatalf("应 2 行，got %d", len(rows))
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	rows, _ = s.ListTests(10)
	if len(rows) != 0 {
		t.Fatalf("清空后应 0 行，got %d", len(rows))
	}
}

func TestSettingsRoundtrip(t *testing.T) {
	// 直接测 Normalize 收敛；文件读写依赖用户目录，这里只验证逻辑
	s := Settings{Mode: "x", LengthS: 1, DownThreads: 0, UpThreads: 99}
	s.Normalize()
	if s.Mode != engine.ModeBoth || s.LengthS != 5 || s.DownThreads != 8 || s.UpThreads != 32 {
		t.Errorf("Normalize 不对: %+v", s)
	}
	o := s.ToOptions()
	if o.LengthS != 5 || o.Mode != engine.ModeBoth || o.DownThreads != 8 || o.UpThreads != 32 {
		t.Errorf("ToOptions 不对: %+v", o)
	}
}
