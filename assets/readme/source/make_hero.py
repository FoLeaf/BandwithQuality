#!/usr/bin/env python3
"""Generate assets/readme/hero.svg — BandwithQuality README 首屏 hero。

左侧为标题区；右侧是应用内 SpeedGauge（frontend/src/components/SpeedGauge.tsx）
的忠实静态复刻：同一套非线性档位（STOPS）、锋利三角刻度环、贴圆缘进度弧与
速度针，几何按 app 的 260 单位 viewBox 等比放大 S 倍。

改动后重新生成：
    python assets/readme/source/make_hero.py
"""
from math import cos, sin, radians
from pathlib import Path

# ---- 仪表盘几何（与 SpeedGauge.tsx 一致，乘以缩放 S） ----
STOPS = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 1500, 2500]
START_ANGLE = 135.0   # 底部左侧起
SWEEP = 270.0
ZONE_RED = 2000       # >= 该值的刻度转红

CX, CY, S = 985.0, 212.0, 1.42
R_FACE = 86 * S        # 圆盘 / 进度弧半径
R_TICK_IN = 91 * S     # 刻度起点（圆缘外留呼吸）
R_MAJOR = 105 * S      # 主刻度（档位）外端
R_MINOR = 99 * S       # 次刻度外端
R_NEEDLE = 112 * S     # 速度针外端
R_LABEL = 115.5 * S    # 档位数字半径

READING = 672.8                      # 示意实时读数（Mbps）
PHASE_LABEL = "多线程下行 · 58%"

TEAL = "#008C8B"
AMBER = "#CC7044"
RED = "#EF4444"


def polar(r: float, deg: float) -> tuple[float, float]:
    rad = radians(deg)
    return CX + r * cos(rad), CY + r * sin(rad)


def v2f(v: float) -> float:
    """值 → 弧上位置比例（分段线性插值，超上限钳制），同 app 的 valueToFraction。"""
    c = max(0.0, min(v, STOPS[-1]))
    for i in range(1, len(STOPS)):
        if c <= STOPS[i]:
            seg = (c - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1])
            return (i - 1 + seg) / (len(STOPS) - 1)
    return 1.0


def sharp_tick(rin: float, rout: float, deg: float, w: float) -> str:
    """锋利刻度：内侧宽 w 的底边，向外收成尖（同 app 的 sharpTick）。"""
    rad = radians(deg)
    dx, dy = cos(rad), sin(rad)
    px, py = -dy, dx
    b1x, b1y = CX + rin * dx + px * w / 2, CY + rin * dy + py * w / 2
    b2x, b2y = CX + rin * dx - px * w / 2, CY + rin * dy - py * w / 2
    tip = polar(rout, deg)
    return f"M {b1x:.2f} {b1y:.2f} L {b2x:.2f} {b2y:.2f} L {tip[0]:.2f} {tip[1]:.2f} Z"


def arc(r: float, a0: float, a1: float) -> str:
    p0, p1 = polar(r, a0), polar(r, a1)
    large = 1 if a1 - a0 > 180 else 0
    return f"M {p0[0]:.2f} {p0[1]:.2f} A {r:.2f} {r:.2f} 0 {large} 1 {p1[0]:.2f} {p1[1]:.2f}"


def build_gauge() -> list[str]:
    needle_angle = START_ANGLE + v2f(READING) * SWEEP
    arc_w = round(3 * S, 2)
    lines = ['  <!-- 右侧仪表盘：SpeedGauge 的静态复刻 -->', '  <g>']
    lines.append(
        f'    <circle cx="{CX}" cy="{CY}" r="{R_FACE:.2f}" fill="url(#face)" '
        f'stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="{1 * S:.2f}"/>'
    )
    lines.append(
        f'    <circle cx="{CX}" cy="{CY}" r="{R_FACE:.2f}" fill="none" '
        f'stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="{arc_w}"/>'
    )
    lines.append(
        f'    <path d="{arc(R_FACE, START_ANGLE, needle_angle)}" fill="none" '
        f'stroke="{TEAL}" stroke-width="{arc_w}" stroke-linecap="round"/>'
    )
    lines.append('')
    lines.append('    <!-- 刻度环：档位主刻度 + 每段 4 根次刻度，红区（>=2000）转红 -->')

    ticks = []
    for i, s in enumerate(STOPS):
        entries = [(s, True)]
        if i < len(STOPS) - 1:
            for k in range(1, 5):
                entries.append((s + (STOPS[i + 1] - s) * k / 4, False))
        for v, major in entries:
            a = START_ANGLE + v2f(v) * SWEEP
            d = sharp_tick(R_TICK_IN, R_MAJOR if major else R_MINOR, a, 3.7 if major else 2.1)
            red = v >= ZONE_RED
            fill = RED if red else "#FFFFFF"
            op = (0.55 if red else 0.5) if major else (0.3 if red else 0.26)
            ticks.append(f'    <path d="{d}" fill="{fill}" opacity="{op}"/>')
    lines.extend(ticks)

    lines.append('')
    lines.append('    <!-- 档位数字 -->')
    for s in STOPS:
        x, y = polar(R_LABEL, START_ANGLE + v2f(s) * SWEEP)
        red = s >= ZONE_RED
        fill = RED if red else "#FFFFFF"
        op = 0.7 if red else 0.6
        lines.append(
            f'    <text x="{x:.2f}" y="{y:.2f}" dy="0.35em" text-anchor="middle" '
            f'font-size="14" font-weight="600" fill="{fill}" opacity="{op}">{s}</text>'
        )

    lines.append('')
    lines.append('    <!-- 当前速度针（相位色）+ 根部小圆点 -->')
    lines.append(
        f'    <path d="{sharp_tick((91 + 2) * S, R_NEEDLE, needle_angle, 3 * S)}" fill="{TEAL}"/>'
    )
    nx, ny = polar((91 + 2) * S, needle_angle)
    lines.append(f'    <circle cx="{nx:.2f}" cy="{ny:.2f}" r="{1.8 * S:.2f}" fill="{TEAL}"/>')

    lines.append('')
    lines.append('    <!-- 中心读数 -->')
    lines.append('    <g text-anchor="middle">')
    lines.append(
        '      <g transform="translate(922,196)">\n'
        '        <path d="M 0 -11 L 0 11 M -7 4 L 0 11 L 7 4" fill="none" '
        f'stroke="{TEAL}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>\n'
        '      </g>'
    )
    lines.append(
        '      <text x="999" y="210" dy="0.02em" font-size="48" font-weight="600" '
        'letter-spacing="-1" fill="#F5F7FA">672.8</text>'
    )
    lines.append('      <text x="985" y="246" font-size="15" fill="#96A0B0">Mbps</text>')
    lines.append(
        f'      <text x="985" y="272" font-size="13.5" fill="#96A0B0">{PHASE_LABEL}</text>'
    )
    lines.append('    </g>')
    lines.append('  </g>')
    return lines


CHIPS = [
    (72, 104, "Go + Wails"),
    (188, 152, "React 18 · Tailwind"),
    (352, 136, "SQLite 本地存储"),
    (500, 140, "Windows 单 exe"),
]


def build_title() -> list[str]:
    lines = ['  <!-- 左侧标题区 -->', '  <g>']
    lines.append(f'    <path d="M 72 96 L 76.5 84 L 81 96 Z" fill="{TEAL}"/>')
    lines.append(f'    <path d="M 88 96 L 92.5 84 L 97 96 Z" fill="{AMBER}"/>')
    lines.append(f'    <path d="M 104 96 L 108.5 84 L 113 96 Z" fill="{RED}"/>')
    lines.append(
        '    <text x="126" y="96" font-family="ui-monospace, \'Cascadia Code\', Consolas, '
        '\'Courier New\', monospace" font-size="15" letter-spacing="4.5" '
        'fill="#7C8598">BANDWIDTH SPEED TEST</text>'
    )
    lines.append(
        '    <text x="70" y="172" font-size="60" font-weight="800" letter-spacing="-1" '
        'fill="#F5F7FA">BandwithQuality</text>'
    )
    lines.append(
        '    <text x="72" y="226" font-size="26" font-weight="500" fill="#DDE3EA">'
        '高性能、简洁的网络带宽测试工具</text>'
    )
    lines.append(
        '    <text x="72" y="266" font-size="15.5" fill="#96A0B0">'
        '免安装单文件 · 真实大陆节点 · 实时速率曲线 · IPv4 / IPv6 双栈 · 本地历史</text>'
    )
    lines.append('    <g font-size="13.5" fill="#B9C2CF">')
    for x, w, label in CHIPS:
        lines.append(f'      <rect x="{x}" y="300" width="{w}" height="30" rx="15" '
                     'fill="none" stroke="#2E3542"/>')
        lines.append(f'      <text x="{x + w / 2}" y="319.5" text-anchor="middle">{label}</text>')
    lines.append('    </g>')
    lines.append('  </g>')
    return lines


def main() -> None:
    svg = "\n".join(
        [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="100%" '
            "font-family=\"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', "
            "'Microsoft YaHei', sans-serif\">",
            '  <title>BandwithQuality — 高性能、简洁的网络带宽测试工具</title>',
            '  <desc>左侧为项目名与定位；右侧为应用内速度仪表盘的静态复刻：'
            '非线性档位刻度环、锋利刻度、进度弧与 672.8 Mbps 实时读数。</desc>',
            '  <defs>',
            '    <radialGradient id="face" cx="50%" cy="42%" r="66%">',
            '      <stop offset="0%" stop-color="#31313A"/>',
            '      <stop offset="68%" stop-color="#1F1F25"/>',
            '      <stop offset="100%" stop-color="#111114"/>',
            '    </radialGradient>',
            '    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">',
            '      <stop offset="0%" stop-color="#181B22"/>',
            '      <stop offset="100%" stop-color="#12141A"/>',
            '    </linearGradient>',
            '  </defs>',
            '',
            '  <rect width="1200" height="420" fill="url(#bg)"/>',
            '',
            *build_title(),
            '',
            *build_gauge(),
            '</svg>',
            '',
        ]
    )
    out = Path(__file__).resolve().parent.parent / "hero.svg"
    out.write_text(svg, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
