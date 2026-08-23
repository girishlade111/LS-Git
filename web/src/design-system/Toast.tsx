import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { IconButton } from './IconButton'

export type ToastVariant = 'info' | 'success' | 'danger'

export interface ToastOptions {
  title: string
  message?: string
  variant?: ToastVariant
  /** Auto-dismiss after ms. Default 5000. */
  duration?: number
}

interface InternalToast extends Required<Omit<ToastOptions, 'message'>> {
  id: number
  message?: string
}

const ToastContext = createContext<{ show: (t: ToastOptions) => void } | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

/** Live-region toast system: announcements are polite; auto-dismisses per toast. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(
    ({ title, message, variant = 'info', duration = 5000 }: ToastOptions) => {
      const id = nextId.current++
      setToasts((list) => [...list, { id, title, message, variant, duration }])
    },
    [],
  )

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ls-toasts" role="region" aria-label="Notifications">
        {/* Polite live region: new toasts are announced without interrupting */}
        <div aria-live="polite">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ toast, onDismiss }: { toast: InternalToast; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.duration === Infinity) return
    const timer = setTimeout(onDismiss, toast.duration)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`ls-toast ls-toast--${toast.variant}`}>
      <div className="ls-toast__body">
        <div className="ls-toast__title">{toast.title}</div>
        {toast.message && <div className="ls-toast__message">{toast.message}</div>}
      </div>
      <IconButton label="Dismiss notification" icon="close" onClick={onDismiss} />
    </div>
  )
}

export { ToastProvider as default }
