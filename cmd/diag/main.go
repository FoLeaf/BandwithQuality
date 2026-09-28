// 诊断工具：排查特定测速节点不可用问题（仅开发用，不参与 wails 构建）
// 用法: go run ./cmd/diag [省份 城市 运营商]  默认 江西 赣州 电信
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	pkgName  = "com.cnspeedtest.globalspeed"
	uaDalvik = "Dalvik/2.1.0 (Linux; U; Android 14; NE2210 Build/TP1A.220624.014)"
)

var ctrlServers = []string{
	"https://dlcv2.cnspeedtest.cn:8443",
	"http://dlc.duoweisoft.com:8096",
	"http://dlcv2.duoweisoft.com:8088",
}

// 显式不走任何代理，排除环境变量干扰
var client = &http.Client{
	Timeout:   25 * time.Second,
	Transport: &http.Transport{Proxy: nil},
}

func get(raw string, timeout time.Duration) (string, error) {
	c := &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil}}
	req, _ := http.NewRequest("GET", raw, nil)
	req.Header.Set("User-Agent", uaDalvik)
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return string(b), nil
}

func main() {
	prov, city, oper := "江西", "赣州", "电信"
	if len(os.Args) == 4 {
		prov, city, oper = os.Args[1], os.Args[2], os.Args[3]
	}
	fmt.Printf("=== 节点诊断: %s %s %s ===\n", prov, city, oper)
	fmt.Println("HTTP_PROXY env:", os.Getenv("HTTP_PROXY"), os.Getenv("http_proxy"), os.Getenv("ALL_PROXY"))

	var base string
	for _, b := range ctrlServers {
		body, err := get(b+"/dataServer/getIpLocSP.php", 6*time.Second)
		if err != nil {
			fmt.Printf("[probe] %s → err %v\n", b, err)
			continue
		}
		base = b
		fmt.Printf("[probe] %s → %s\n", b, strings.ReplaceAll(strings.TrimSpace(body), "\n", " ")[:min(80, len(strings.TrimSpace(body)))])
		break
	}

	ip := ""
	if body, err := get(base+"/dataServer/getIpLocSP.php", 6*time.Second); err == nil {
		ip = strings.Split(strings.TrimSpace(body), "|")[0]
	}
	v := url.Values{}
	v.Set("ip", ip)
	v.Set("network", "4")
	v.Set("province", prov)
	v.Set("city", city)
	v.Set("wifioper", oper)
	v.Set("mobileoperid", "")
	v.Set("ipv6", "0")
	v.Set("model", "Android")
	v.Set("pkg", pkgName)
	listURL := base + "/dataServer/mobilematch_many.php?" + v.Encode()
	raw, err := get(listURL, 12*time.Second)
	if err != nil {
		fmt.Println("[list] err:", err)
		return
	}
	fmt.Println("\n[list] 原始 JSON（含全部字段）:")
	var pretty any
	if json.Unmarshal([]byte(raw), &pretty) == nil {
		b, _ := json.MarshalIndent(pretty, "  ", "  ")
		fmt.Println("  " + string(b))
	} else {
		fmt.Println("  " + raw)
	}

	var nodes []map[string]any
	_ = json.Unmarshal([]byte(raw), &nodes)
	for _, n := range nodes {
		host := fmt.Sprint(n["hostip"])
		port := fmt.Sprint(n["port"])
		name := fmt.Sprint(n["hostname"])
		fmt.Printf("\n--- 节点 %s (%s:%s) ---\n", name, host, port)

		// 1. TCP 连接计时
		t0 := time.Now()
		c, err := net.DialTimeout("tcp", host+":"+port, 3*time.Second)
		if err != nil {
			fmt.Printf("  TCP: 失败 %v\n", err)
			continue
		}
		fmt.Printf("  TCP: 通，耗时 %v\n", time.Since(t0).Round(time.Millisecond))
		c.Close()

		// 2. dovalid 排队（长超时 25s，观察是慢还是死）
		ts := fmt.Sprint(time.Now().Unix())
		dv := fmt.Sprintf("http://%s:%s/speed/dovalid?key=&flag=true&bandwidth=200&model=Android&imei=TSDIAG0000000001&time=%s&app=globalspeed&token=diag&pkg=%s",
			host, port, ts, pkgName)
		t0 = time.Now()
		body, err := get(dv, 25*time.Second)
		if err != nil {
			fmt.Printf("  dovalid(25s): 失败，耗时 %v → %v\n", time.Since(t0).Round(time.Millisecond), err)
		} else {
			fmt.Printf("  dovalid(25s): 成功，耗时 %v → body=%q\n", time.Since(t0).Round(time.Millisecond), strings.TrimSpace(body[:min(120, len(body))]))
		}

		// 3. 数据面：裸 TCP 发下载请求看响应头（key 是假的，看服务是否活着）
		t0 = time.Now()
		c, err = net.DialTimeout("tcp", host+":"+port, 3*time.Second)
		if err == nil {
			req := fmt.Sprintf("GET /speed/File(1G).dl?r=%d&key=diag HTTP/1.1\r\nAccept: */*\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\nHost: %s:%s\r\n\r\n",
				time.Now().Unix(), host, port)
			_ = c.SetDeadline(time.Now().Add(10 * time.Second))
			if _, werr := c.Write([]byte(req)); werr == nil {
				buf := make([]byte, 256)
				n, rerr := c.Read(buf)
				fmt.Printf("  数据面: %v 响应，耗时 %v → %q\n", rerr == nil, time.Since(t0).Round(time.Millisecond), strings.TrimSpace(string(buf[:min(n, 80)])))
			}
			c.Close()
		}

		// 4. HTTPS 变体
		if strings.HasPrefix(base, "https://") || true {
			t0 = time.Now()
			hbody, herr := get(fmt.Sprintf("https://%s:%s/speed/dovalid?key=&flag=true&bandwidth=200&model=Android&imei=TSDIAG0000000001&time=%s&app=globalspeed&token=diag&pkg=%s", host, port, ts, pkgName), 8*time.Second)
			if herr != nil {
				fmt.Printf("  dovalid-https(8s): 失败，耗时 %v → %v\n", time.Since(t0).Round(time.Millisecond), herr)
			} else {
				fmt.Printf("  dovalid-https(8s): 成功，耗时 %v → body=%q\n", time.Since(t0).Round(time.Millisecond), strings.TrimSpace(hbody[:min(120, len(hbody))]))
			}
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
