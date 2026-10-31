import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html 里找不到 #root —— 挂载点被删掉了')
}

createRoot(container).render(
  <StrictMode>
    <App appName="{{appName}}" />
  </StrictMode>,
)
