export type StatusKind = 'success' | 'failed' | 'running' | 'pending' | 'neutral'

const labels: Record<StatusKind, string> = {
  success: 'Success',
  failed: 'Failed',
  running: 'Running',
  pending: 'Pending',
  neutral: 'Neutral',
}

export function StatusIndicator({
  status,
  label,
}: {
  status: StatusKind
  /** Optional visible label; a screen-reader name is always provided. */
  label?: string
}) {
  return (
    <span className={`ls-status ls-status--${status}`}>
      <span className="ls-status__dot" aria-hidden="true" />
      <span>{label ?? labels[status]}</span>
    </span>
  )
}
