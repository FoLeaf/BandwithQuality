import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"
import { Toaster } from "@/components/ui/sonner"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/* top 偏移避开自绘标题栏（h-10）；450px 窄窗命中 sonner 的 mobile 断言，需一并设置 mobileOffset */}
    <Toaster position="top-center" richColors offset={{ top: 48 }} mobileOffset={{ top: 48 }} />
  </React.StrictMode>,
)
