import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ToastProvider } from './design-system/Toast'
import './styles/tokens.css'
import './styles/base.css'
import './design-system/design-system.css'
import './design-system/overlays.css'
import './design-system/data.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
