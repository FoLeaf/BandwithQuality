package engine

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func almost(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestCalcMbps(t *testing.T) {
	// 125000 字节 = 1Mb；1000ms → 1Mbps
	almost(t, "1Mbps", calcMbps(125000, 1000), 1)
	almost(t, "8Mbps", calcMbps(1_000_000, 1000), 8)
	if calcMbps(100, 0) != 0 {
		t.Error("durationMS=0 应返回 0")
	}
}

func TestSustainedMbps(t *testing.T) {
	// 5 个采样剔 1 个最慢：(3+5+7+9)/4
	almost(t, "剔除最慢30%", sustainedMbps([]float64{1, 9, 5, 7, 3}), 6)
	// 采样不足 4 个不剔除，直接均值
	almost(t, "三采样不剔", sustainedMbps([]float64{1, 2, 3}), 2)
	almost(t, "短序列", sustainedMbps([]float64{4, 6}), 5)
	almost(t, "单点", sustainedMbps([]float64{2}), 2)
	// 一次谷底不该把可持续速率拉低：{10,100×5} 剔 10 后仍是 100
	almost(t, "谷底剔除", sustainedMbps([]float64{100, 100, 10, 100, 100, 100}), 100)
	if sustainedMbps(nil) != 0 {
		t.Error("空序列应为 0")
	}
}

func TestJitterMS(t *testing.T) {
	almost(t, "等差", jitterMS([]float64{1, 2, 3, 4}), 1)
	almost(t, "抖动", jitterMS([]float64{5, 7, 6}), 1.5) // (2+1)/2
	if jitterMS([]float64{1}) != 0 {
		t.Error("单样本抖动应为 0")
	}
}

func TestEnqueueTokenDeterministic(t *testing.T) {
	a := enqueueToken("TS0123456789ABCDEF", "1700000000", 200)
	b := enqueueToken("TS0123456789ABCDEF", "1700000000", 200)
	if a != b || len(a) != 32 {
		t.Fatalf("token 应为确定的 32 位 hex: %q vs %q", a, b)
	}
	c := enqueueToken("TS0123456789ABCDEG", "1700000000", 200)
	if c == a {
		t.Error("不同 imei 应产生不同 token")
	}
}

func TestHostPort(t *testing.T) {
	if got := hostPort("1.2.3.4", 8080); got != "1.2.3.4:8080" {
		t.Errorf("v4: %q", got)
	}
	if got := hostPort("2001:db8::1", 8080); got != "[2001:db8::1]:8080" {
		t.Errorf("v6: %q", got)
	}
	if got := hostPort("[2001:db8::1]", 8080); got != "[2001:db8::1]:8080" {
		t.Errorf("已带括号: %q", got)
	}
}

func TestParsePingOutputWindowsEnglish(t *testing.T) {
	out := strings.Join([]string{
		"Pinging 1.2.3.4 with 32 bytes of data:",
		"Reply from 1.2.3.4: bytes=32 time=23ms TTL=57",
		"Reply from 1.2.3.4: bytes=32 time=25ms TTL=57",
		"Request timed out.",
		"Reply from 1.2.3.4: bytes=32 time<1ms TTL=57",
		"Reply from 1.2.3.4: bytes=32 time=24ms TTL=57",
		"",
		"Ping statistics for 1.2.3.4:",
		"    Packets: Sent = 5, Received = 4, Lost = 1 (20% loss),",
		"Approximate round trip times in milli-seconds:",
		"    Minimum = 23ms, Maximum = 25ms, Average = 24ms",
	}, "\r\n")
	ts := parsePingOutput(out)
	if len(ts) != 4 {
		t.Fatalf("应解析出 4 个样本（排除超时行与统计行），got %v", ts)
	}
	if ts[0] != 23 || ts[1] != 25 || ts[2] != 1 || ts[3] != 24 {
		t.Errorf("样本值不对: %v", ts)
	}
}

func TestParsePingOutputChineseGBK(t *testing.T) {
	// 中文 Windows 的 GBK 输出按字节读入（非法 UTF-8 序列保留为原字节），
	// 非 ASCII 字节不干扰 ASCII 的 `=5ms`/`TTL` 匹配，统计行仍被 TTL 过滤排除
	gbk := []byte{0xd0, 0xc5, 0xcf, 0xa2} // 任意非 ASCII 字节前缀，模拟 GBK
	var b []byte
	b = append(b, gbk...)
	b = append(b, []byte(": =32 =5ms TTL=57\r\n: =32 =7ms TTL=57\r\n= 5ms = 7ms = 6ms")...)
	ts := parsePingOutput(string(b))
	if len(ts) != 2 || ts[0] != 5 || ts[1] != 7 {
		t.Fatalf("GBK 输出应解析出 2 个样本，got %v", ts)
	}
}

func TestParsePingOutputLinux(t *testing.T) {
	out := "64 bytes from 1.2.3.4: icmp_seq=1 ttl=56 time=12.3 ms\n" +
		"64 bytes from 1.2.3.4: icmp_seq=2 ttl=56 time=13.4 ms\n" +
		"\n--- 1.2.3.4 ping statistics ---\n" +
		"rtt min/avg/max/mdev = 12.300/12.850/13.400/0.550 ms"
	ts := parsePingOutput(out)
	if len(ts) != 2 || ts[0] != 12.3 || ts[1] != 13.4 {
		t.Fatalf("Linux 输出解析不对: %v", ts)
	}
}

func TestPingArgs(t *testing.T) {
	// 本测试在 Windows CI/本机断言 Windows 参数；其他平台只校验个数
	args := pingArgs(4, false)
	if runtime.GOOS == "windows" {
		want := []string{"-n", "4", "-w", "1000"}
		if strings.Join(args, " ") != strings.Join(want, " ") {
			t.Errorf("Windows ping 参数 = %v, want %v", args, want)
		}
	}
	v6 := pingArgs(2, true)
	if len(v6) != len(args)+1 {
		t.Errorf("IPv6 应多一个 -6 参数: %v", v6)
	}
}

func TestNormalizeAndResolve(t *testing.T) {
	if p, c, err := resolveLocation("湖北省"); err != nil || p != "湖北" || c != "武汉" {
		t.Errorf("湖北省 → %v %v %v", p, c, err)
	}
	if p, c, err := resolveLocation("深圳"); err != nil || p != "广东" || c != "深圳" {
		t.Errorf("深圳 → %v %v %v", p, c, err)
	}
	if p, c, err := resolveLocation("武汉"); err != nil || p != "湖北" || c != "武汉" {
		t.Errorf("武汉 → %v %v %v", p, c, err)
	}
	if _, _, err := resolveLocation("火星"); err == nil {
		t.Error("火星应报错")
	}
	if normalizeProvince("内蒙古自治区") != "内蒙古" {
		t.Error("自治区后缀应被剥掉")
	}
}

func TestPickNodeFallback(t *testing.T) {
	nodes := []Node{
		{HostName: "广东深圳电信", HostIP: "1.1.1.1", Port: 8080, City: "深圳", PName: "广东"},
		{HostName: "湖北武汉电信", HostIP: "2.2.2.2", Port: 8080, City: "武汉", PName: "湖北"},
		{HostName: "北京联通", HostIP: "3.3.3.3", Port: 8080, City: "北京", PName: "北京"},
	}
	reachable := map[string]bool{"3.3.3.3": true}
	prober := func(ip string, port int) bool { return reachable[ip] }

	// 一级：同运营商+省市匹配且可达
	if n := pickNode(nodes, "北京", "北京", "联通", prober); n == nil || n.HostIP != "3.3.3.3" {
		t.Errorf("一级匹配应选 3.3.3.3, got %+v", n)
	}
	// 二级：匹配但不可达 → 任意可达
	if n := pickNode(nodes, "北京", "北京", "电信", prober); n == nil || n.HostIP != "3.3.3.3" {
		t.Errorf("二级回退应选 3.3.3.3, got %+v", n)
	}
	// 三级：全不可达 → 兜底第一个
	if n := pickNode(nodes, "北京", "北京", "电信", func(string, int) bool { return false }); n == nil || n.HostIP != "1.1.1.1" {
		t.Errorf("三级兜底应选 1.1.1.1, got %+v", n)
	}
	// prober 为 nil 直接兜底
	if n := pickNode(nodes, "北京", "北京", "电信", nil); n == nil || n.HostIP != "1.1.1.1" {
		t.Errorf("nil prober 应兜底第一个, got %+v", n)
	}
	if pickNode(nil, "", "", "", prober) != nil {
		t.Error("空列表应返回 nil")
	}
}

func TestMakeIMEI(t *testing.T) {
	re := regexp.MustCompile(`^TS[0-9A-F]{16}$`)
	for i := 0; i < 10; i++ {
		if !re.MatchString(makeIMEI()) {
			t.Fatalf("IMEI 格式不对: %q", makeIMEI())
		}
	}
}

func TestOptionsFill(t *testing.T) {
	o := Options{}
	o.fill()
	if o.Mode != ModeMulti || o.LengthS != 13 || o.IntervalMS != 500 || o.DownThreads != 16 || o.UpThreads != 8 {
		t.Errorf("默认值不对: %+v", o)
	}
	o2 := Options{LengthS: 99, Mode: "x", IntervalMS: 10}
	o2.fill()
	if o2.LengthS != 13 || o2.Mode != ModeMulti || o2.IntervalMS != 500 {
		t.Errorf("越界值应收敛: %+v", o2)
	}
	if o.Family != FamilyV4 {
		t.Errorf("family 默认应为 v4: %+v", o)
	}
	if f := (Options{Family: FamilyV6}); func() string { f.fill(); return f.Family }() != FamilyV6 {
		t.Error("合法 family 不应被改写")
	}
	if f := (Options{IPv6: true}); func() string { f.fill(); return f.Family }() != FamilyBoth {
		t.Error("旧 ipv6=true 应迁移为 both")
	}
	if f := (Options{Family: "x"}); func() string { f.fill(); return f.Family }() != FamilyV4 {
		t.Error("非法 family 应回退 v4")
	}
}

func TestPhaseList(t *testing.T) {
	both := phaseList(ModeBoth)
	if len(both) != 4 || both[0] != PhaseDownSingle || both[3] != PhaseUpMulti {
		t.Errorf("both 阶段顺序: %v", both)
	}
	if len(phaseList(ModeSingle)) != 2 || len(phaseList(ModeMulti)) != 2 {
		t.Error("single/multi 应各 2 阶段")
	}
}

func TestSafeStrAndDisplayName(t *testing.T) {
	if safeStr(nil) != "" {
		t.Error("nil 应为空串")
	}
	if safeStr("8080") != "8080" {
		t.Error("字符串应原样返回")
	}
	if safeStr(float64(8080)) != "8080" {
		t.Errorf("数值应转成 %q", safeStr(float64(8080)))
	}
	n := Node{City: "武汉", Oper: "电信", HostName: "湖北武汉电信"}
	if n.DisplayName() != "武汉电信" {
		t.Errorf("DisplayName = %q", n.DisplayName())
	}
	n2 := Node{HostName: "某某节点"}
	if n2.DisplayName() != "某某节点" {
		t.Errorf("缺省时应用 HostName: %q", n2.DisplayName())
	}
}

func TestShortIP(t *testing.T) {
	if shortIP("111.22.33.44") != "111.22.*.*" {
		t.Errorf("v4 打码: %q", shortIP("111.22.33.44"))
	}
	if !strings.Contains(shortIP("2001:db8::1"), "2001") {
		t.Errorf("v6 不应打码: %q", shortIP("2001:db8::1"))
	}
}

func TestOptionsPreserveExplicitSettings(t *testing.T) {
	for _, mode := range []string{ModeSingle, ModeMulti, ModeBoth} {
		o := Options{Mode: mode, LengthS: 5, DownThreads: 8, UpThreads: 4, Family: FamilyBoth, IntervalMS: 500}
		want := o
		o.fill()
		if o != want {
			t.Fatalf("explicit settings changed: got %+v want %+v", o, want)
		}
	}
	o := Options{LengthS: 1}
	o.fill()
	if o.LengthS != 5 {
		t.Fatalf("positive duration must still clamp to minimum: %+v", o)
	}
}

func TestOperOrder(t *testing.T) {
	if got := operOrder("电信"); strings.Join(got, ",") != "电信,联通,移动" {
		t.Errorf("电信优先次序 = %v", got)
	}
	if got := operOrder("移动"); strings.Join(got, ",") != "移动,电信,联通" {
		t.Errorf("移动优先次序 = %v", got)
	}
	// 非主流运营商保留首位，主流三家跟后
	if got := operOrder("广电"); strings.Join(got, ",") != "广电,电信,联通,移动" {
		t.Errorf("非主流运营商次序 = %v", got)
	}
}

// nodeJSON 构造 mobilematch_many.php 的单节点列表响应。
func nodeJSON(host, port, name string) string {
	return fmt.Sprintf(`[{"hostid":"1","pname":"江西","city":"赣州","port":"%s","hostname":"%s","hostip":"%s"}]`, port, name, host)
}

// deadPort 本机无监听端口：连接立即被拒，可让排队快速失败而不必等超时。
const deadPort = "1"

func TestSelectAndEnqueueCrossOperFallback(t *testing.T) {
	// 好节点：dovalid 直接返回成功 body（body[2:] 为 uuid）
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("1|uuid-ok"))
	}))
	defer good.Close()
	goodHost, goodPort, _ := net.SplitHostPort(strings.TrimPrefix(good.URL, "http://"))

	// 控制面：电信给死节点列表，联通给好节点 → 应跨运营商回退成功
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("wifioper") {
		case "电信":
			_, _ = w.Write([]byte(nodeJSON("127.0.0.1", deadPort, "赣州电信")))
		case "联通":
			_, _ = w.Write([]byte(nodeJSON(goodHost, goodPort, "赣州联通")))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer ctrl.Close()

	var msgs []string
	cb := Callbacks{OnProgress: func(p Progress) { msgs = append(msgs, p.Message) }}
	loc := ClientLocation{IP: "1.2.3.4", Province: "江西", City: "赣州", Oper: "电信"}
	uuid, node, err := selectAndEnqueue(context.Background(), cb, ctrl.URL, loc, false, "TS0123456789ABCDEF", 10)
	if err != nil {
		t.Fatalf("跨运营商回退应成功: %v", err)
	}
	if uuid != "uuid-ok" {
		t.Errorf("uuid = %q, want uuid-ok", uuid)
	}
	if node == nil || node.Oper != "联通" || node.HostIP != goodHost {
		t.Errorf("应选中联通好节点, got %+v", node)
	}
	joined := strings.Join(msgs, "\n")
	if !strings.Contains(joined, "尝试联通") {
		t.Errorf("应有跨运营商提示消息: %v", msgs)
	}
}

func TestSelectAndEnqueueSameOper(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("1|uuid-ok"))
	}))
	defer good.Close()
	goodHost, goodPort, _ := net.SplitHostPort(strings.TrimPrefix(good.URL, "http://"))

	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(nodeJSON(goodHost, goodPort, "赣州电信")))
	}))
	defer ctrl.Close()

	loc := ClientLocation{IP: "1.2.3.4", Province: "江西", City: "赣州", Oper: "电信"}
	uuid, node, err := selectAndEnqueue(context.Background(), Callbacks{}, ctrl.URL, loc, false, "TS0123456789ABCDEF", 10)
	if err != nil || uuid != "uuid-ok" || node == nil || node.Oper != "电信" {
		t.Fatalf("同运营商应直接成功: uuid=%q node=%+v err=%v", uuid, node, err)
	}
}

func TestSelectAndEnqueueAllOperFail(t *testing.T) {
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(nodeJSON("127.0.0.1", deadPort, "节点")))
	}))
	defer ctrl.Close()

	loc := ClientLocation{IP: "1.2.3.4", Province: "江西", City: "赣州", Oper: "电信"}
	_, _, err := selectAndEnqueue(context.Background(), Callbacks{}, ctrl.URL, loc, false, "TS0123456789ABCDEF", 10)
	if err == nil {
		t.Fatal("全部运营商失败应报错")
	}
	if !strings.Contains(err.Error(), "已依次尝试 电信、联通、移动") {
		t.Errorf("错误应说明尝试过的运营商: %v", err)
	}
}
