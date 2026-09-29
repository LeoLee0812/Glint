import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
// 按键路由有副作用（注册手柄 / 语音 / Jev 回调），在这里加载一次
import './input/router'
// ⌥ + 点击 = 漂移校正
import './input/clickCalibrate'
// 菜单栏图标：推状态、收命令
import './tray'
import './debug'

// 不用 StrictMode：开发模式下它会把副作用跑两遍，终端会被重复创建
createRoot(document.getElementById('root')!).render(<App />)
