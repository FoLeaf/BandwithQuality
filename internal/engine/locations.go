package engine

import (
	"fmt"
	"strings"
)

// isps 三大运营商。
var isps = []string{"电信", "联通", "移动"}

// provinceCity 省 → 省会（用于按省浏览节点时兜底城市）。
var provinceCity = map[string]string{
	"北京": "北京", "天津": "天津", "上海": "上海", "重庆": "重庆",
	"河北": "石家庄", "山西": "太原", "内蒙古": "呼和浩特",
	"辽宁": "沈阳", "吉林": "长春", "黑龙江": "哈尔滨",
	"江苏": "南京", "浙江": "杭州", "安徽": "合肥", "福建": "福州",
	"江西": "南昌", "山东": "济南", "河南": "郑州", "湖北": "武汉",
	"湖南": "长沙", "广东": "广州", "广西": "南宁", "海南": "海口",
	"四川": "成都", "贵州": "贵阳", "云南": "昆明", "西藏": "拉萨",
	"陕西": "西安", "甘肃": "兰州", "青海": "西宁", "宁夏": "银川",
	"新疆": "乌鲁木齐", "台湾": "台北", "香港": "香港", "澳门": "澳门",
}

// extraCity 无需省份即可定位的计划单列市/经济强市。
var extraCity = map[string][2]string{
	"深圳": {"广东", "深圳"}, "苏州": {"江苏", "苏州"}, "宁波": {"浙江", "宁波"},
	"青岛": {"山东", "青岛"}, "厦门": {"福建", "厦门"}, "东莞": {"广东", "东莞"},
	"无锡": {"江苏", "无锡"}, "佛山": {"广东", "佛山"},
}

// CapitalOf 省份对应省会；不是省则返回空串。
func CapitalOf(prov string) string {
	return provinceCity[prov]
}

// ISPList 运营商名单。
func ISPList() []string {
	return append([]string(nil), isps...)
}

// normalizeProvince 去掉省/自治区等后缀并做常见别名归一。
func normalizeProvince(s string) string {
	s = strings.TrimSpace(s)
	for _, suf := range []string{"特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"} {
		s = strings.TrimSuffix(s, suf)
	}
	alias := map[string]string{"bj": "北京", "sh": "上海", "gd": "广东", "gz": "广东", "hb": "湖北", "js": "江苏"}
	if v, ok := alias[strings.ToLower(s)]; ok {
		return v
	}
	return s
}

// resolveLocation 把「湖北」「武汉」「深圳」这类输入解析成 省+市。
func resolveLocation(name string) (prov, city string, err error) {
	loc := normalizeProvince(name)
	if loc == "" {
		return "", "", fmt.Errorf("空的测速点")
	}
	if v, ok := extraCity[loc]; ok {
		return v[0], v[1], nil
	}
	if v, ok := provinceCity[loc]; ok {
		return loc, v, nil
	}
	for p, cty := range provinceCity {
		if cty == loc {
			return p, cty, nil
		}
	}
	return "", "", fmt.Errorf("不支持的测速点: %s", name)
}
