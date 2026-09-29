// 窗口比例锁定：非最大化状态下拖拽边缘时，把窗口吸附回 9:16（与 main.go 的初始/最小尺寸一致）。
// Wails 未内建宽高比锁定，这里用 webview 的 DOM resize 事件 + runtime.WindowSetSize 实现。

const RATIO = 9 / 16
const MIN_W = 405
const MIN_H = 720

export function enforceWindowAspect() {
  const rt = (window as any)?.runtime
  if (!rt) return
  let settling = false
  window.addEventListener("resize", () => {
    if (settling) return
    try {
      if (rt.WindowIsMaximised() || rt.WindowIsFullscreen()) return
      const { w, h } = rt.WindowGetSize() as { w: number; h: number }
      // 两个候选：以当前高定宽 / 以当前宽定高，取离现状更近的一支
      const wByH = Math.max(MIN_W, Math.round(h * RATIO))
      const hByW = Math.max(MIN_H, Math.round(w / RATIO))
      let nw: number, nh: number
      if (Math.abs(wByH - w) <= Math.abs(hByW - h)) {
        nw = wByH
        nh = Math.max(MIN_H, Math.round(nw / RATIO))
      } else {
        nh = hByW
        nw = Math.max(MIN_W, Math.round(nh * RATIO))
      }
      if (Math.abs(nw - w) >= 1 || Math.abs(nh - h) >= 1) {
        settling = true
        rt.WindowSetSize(nw, nh)
        window.setTimeout(() => {
          settling = false
        }, 80)
      }
    } catch {
      // 忽略
    }
  })
}
