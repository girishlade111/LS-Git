import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './auth/context'
import { ToastProvider } from './design-system/Toast'
import './styles/tokens.css'
import './styles/base.css'
import './design-system/design-system.css'
import './design-system/overlays.css'
import './design-system/data.css'
import './design-system/uploads.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
)
