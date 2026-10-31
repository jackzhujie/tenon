import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TenonErrorBoundary } from './tenon-boundary'
import { installTenonLog } from './tenon-log'
import './styles.css'

// 先装钩子再渲染：渲染期抛的错要能被上报到日志面板（详见 tenon-log.ts）
installTenonLog()

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html 里找不到 #root —— 挂载点被删掉了')
}

createRoot(container).render(
  <StrictMode>
    <TenonErrorBoundary>
      <App appName="{{appName}}" />
    </TenonErrorBoundary>
  </StrictMode>,
)
