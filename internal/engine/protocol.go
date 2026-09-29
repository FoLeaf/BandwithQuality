package engine

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	pkgName   = "com.cnspeedtest.globalspeed"
	appName   = "globalspeed"
	randSalt  = "12345555"
	uaDalvik  = "Dalvik/2.1.0 (Linux; U; Android 14; NE2210 Build/TP1A.220624.014)"
	uaBrowser = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36"
	uaUpload  = "Dalvik/1.6.0 (Linux; U; Android 4.2.2; GT-I9505 Build/JDQ39)"
	boundary  = "00content0boundary00"
)

// 控制面服务器：主 + 两个 HTTP 备用。
var ctrlServers = []string{
	"https://dlcv2.cnspeedtest.cn:8443",
	"http://dlc.duoweisoft.com:8096",
	"http://dlcv2.duoweisoft.com:8088",
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// enqueueToken 复刻官方 App 的 MD5 令牌：imei+stime/band/rand 两段哈希再哈希。
func enqueueToken(imei, ts string, bandwidth int) string {
	h1 := md5Hex("model=Android&imei=" + imei)
	h2 := md5Hex(fmt.Sprintf("stime=%s&band=%d&rand=%s", ts, bandwidth, randSalt))
	return md5Hex(h1 + h2)
}

// hostPort IPv6 字面量地址自动加方括号。
func hostPort(ip string, port int) string {
	if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
		return fmt.Sprintf("[%s]:%d", ip, port)
	}
	return fmt.Sprintf("%s:%d", ip, port)
}

// safeStr 从接口取字符串，缺失/nil 返回空串（fmt.Sprint(nil) 会给出 "<nil>"）。
func safeStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return strings.TrimSuffix(strings.TrimPrefix(fmt.Sprint(v), "["), "]")
}

// 显式直连：测速工具不应受系统代理环境变量干扰（与 cmd/diag 口径一致）。
// 共享 Transport 以复用连接池。
var noProxyTransport = &http.Transport{Proxy: nil}

func httpGet(raw string, timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: timeout, Transport: noProxyTransport}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", uaDalvik)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func httpPost(raw string, timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: timeout, Transport: noProxyTransport}
	req, err := http.NewRequest(http.MethodPost, raw, strings.NewReader(""))
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", uaDalvik)
	req.Header.Set("Charset", "utf-8")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// fetchClient 依次尝试控制面服务器，探测出口 IP 与省市/运营商。
func fetchClient() (base string, info ClientInfo, err error) {
	var last error
	for _, b := range ctrlServers {
		body, e := httpGet(b+"/dataServer/getIpLocSP.php", 6*time.Second)
		if e != nil {
			last = e
			continue
		}
		parts := strings.Split(strings.TrimSpace(body), "|")
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		info.IP = parts[0]
		if len(parts) > 1 {
			var loc []string
			if json.Unmarshal([]byte(parts[1]), &loc) == nil {
				if len(loc) > 1 {
					info.Province = loc[1]
				}
				if len(loc) > 2 {
					info.City = loc[2]
				}
				if len(loc) > 4 {
					info.Oper = loc[4]
				}
			}
		}
		if info.Oper == "" && len(parts) > 3 {
			info.Oper = parts[3]
		}
		return b, info, nil
	}
	if last == nil {
		last = fmt.Errorf("无法获取出口 IP")
	}
	return "", ClientInfo{}, last
}

// ClientInfo 内部使用的出口信息（types.go 的 ClientLocation 为对外形态）。
type ClientInfo struct {
	IP       string
	Province string
	City     string
	Oper     string
}

func (c ClientInfo) location() ClientLocation {
	return ClientLocation{IP: c.IP, Province: c.Province, City: c.City, Oper: c.Oper}
}

// matchServers 按位置向控制面拉取候选节点列表。
func matchServers(base, ip, province, city, oper string, ipv6 bool) ([]Node, error) {
	v := url.Values{}
	v.Set("ip", ip)
	v.Set("network", "4")
	v.Set("province", province)
	v.Set("city", city)
	v.Set("wifioper", oper)
	v.Set("mobileoperid", "")
	if ipv6 {
		v.Set("ipv6", "1")
	} else {
		v.Set("ipv6", "0")
	}
	v.Set("model", "Android")
	v.Set("pkg", pkgName)
	body, err := httpGet(base+"/dataServer/mobilematch_many.php?"+v.Encode(), 10*time.Second)
	if err != nil {
		return nil, err
	}
	var arr []map[string]any
	if err := json.Unmarshal([]byte(body), &arr); err != nil {
		return nil, err
	}
	out := make([]Node, 0, len(arr))
	for _, item := range arr {
		port := 0
		switch p := item["port"].(type) {
		case string:
			fmt.Sscanf(p, "%d", &port)
		case float64:
			port = int(p)
		}
		n := Node{
			HostID:   safeStr(item["hostid"]),
			HostName: safeStr(item["hostname"]),
			HostIP:   safeStr(item["hostip"]),
			Port:     port,
			PName:    safeStr(item["pname"]),
			City:     safeStr(item["city"]),
			Oper:     oper,
			PingMS:   -1,
		}
		if n.Oper == "" {
			n.Oper = safeStr(item["oper"])
		}
		out = append(out, n)
	}
	return out, nil
}

// tcpOK TCP 可达性探测。
func tcpOK(ip string, port int) bool {
	c, err := net.DialTimeout("tcp", hostPort(ip, port), 2*time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// pickNode 上游的三级回退择优：同运营商+省市匹配且 TCP 可达 → 任意 TCP 可达 → 兜底 servers[0]。
func pickNode(servers []Node, province, city, oper string, prober func(ip string, port int) bool) *Node {
	if len(servers) == 0 {
		return nil
	}
	if prober != nil {
		for i := range servers {
			s := &servers[i]
			if strings.Contains(s.HostName, oper) && (strings.Contains(s.HostName, city) || s.City == city || s.PName == province) {
				if prober(s.HostIP, s.Port) {
					return s
				}
			}
		}
		for i := range servers {
			if prober(servers[i].HostIP, servers[i].Port) {
				return &servers[i]
			}
		}
	}
	return &servers[0]
}

// enqueue dovalid 排队：0=忙 2=排队中重试 -1=参数错误，成功返回 uuid（取 body[2:]）。
func enqueue(s Node, imei string, bandwidth int) (string, error) {
	ts := fmt.Sprintf("%d", time.Now().Unix())
	token := enqueueToken(imei, ts, bandwidth)
	raw := fmt.Sprintf(
		"http://%s/speed/dovalid?key=&flag=true&bandwidth=%d&model=Android&imei=%s&time=%s&app=%s&token=%s&pkg=%s",
		hostPort(s.HostIP, s.Port), bandwidth, url.QueryEscape(imei), ts, appName, token, pkgName,
	)
	var last string
	for i := 0; i < 3; i++ {
		body, err := httpGet(raw, 5*time.Second)
		if err != nil {
			// 网络层失败（超时/EOF/拒连）说明节点服务异常：
			// 立即返回由上层换下一个节点，而不是原地重试浪费时间
			return "", fmt.Errorf("dovalid 请求失败: %w", err)
		}
		body = strings.TrimSpace(body)
		last = body
		if strings.HasPrefix(body, "0") {
			return "", fmt.Errorf("服务器忙")
		}
		if strings.HasPrefix(body, "2") {
			time.Sleep(400 * time.Millisecond)
			continue
		}
		if strings.HasPrefix(body, "-1") {
			return "", fmt.Errorf("dovalid 参数错误")
		}
		if len(body) > 2 {
			return body[2:], nil
		}
	}
	return "", fmt.Errorf("enqueue 失败: %s", last)
}

// dequeue 退队。
func dequeue(s Node, uuid string) {
	_, _ = httpPost("http://"+hostPort(s.HostIP, s.Port)+"/speed/dovalid?key="+uuid, 5*time.Second)
}
