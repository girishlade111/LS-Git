import type { IdentityServices } from './identity.js'

/**
 * PM workflow event subscriber. Sits on the domain-event bus next to the
 * notification fanout: when issue/PR events fire, linked board items move
 * according to each board's workflow rules (issue_closed → Done,
 * pr_merged → Done by default). Failures are swallowed per-board so one bad
 * rule never breaks the emitting operation.
 */
export function pmApplyDomainEvent(s: IdentityServices, row: { id: number; type: string; payload: Record<string, unknown>; project_id: number | null }): void {
  try {
    // Delegate to ProjectManagementService logic without instantiating it:
    // the transition only needs repos.
    applyTransition(s, row)
  } catch {
    // Workflow automation must never break the emitting operation.
  }
}

function applyTransition(s: IdentityServices, row: { type: string; payload: Record<string, unknown>; project_id: number | null }): void {
  if (row.project_id === null) return

  const map: Record<string, { event: string; kind: 'issue' | 'pull_request' }> = {
    'issue.opened': { event: 'issue_opened', kind: 'issue' },
    'issue.updated': {
      event: row.payload.action === 'closed' ? 'issue_closed'
        : row.payload.action === 'reopened' ? 'issue_reopened'
        : '',
      kind: 'issue',
    },
    'mr.opened': { event: 'pr_opened', kind: 'pull_request' },
    'mr.merged': { event: 'pr_merged', kind: 'pull_request' },
  }
  const entry = map[row.type]
  if (!entry || entry.event === '') return
  const iid = Number(row.payload.iid)
  if (!Number.isInteger(iid) || iid <= 0) return

  const items = s.pmItems.findLinked(row.project_id, entry.kind, iid)
  for (const item of items) {
    const board = s.pmBoards.byId(item.board_id)
    if (!board) continue
    const target = s.pmWorkflows.targetFor(board.id, entry.event)
    if (!target) continue
    const statusField = s.pmFields.byKey(board.id, 'status')
    if (!statusField) continue
    const fromRow = s.pmItemValues.get(item.id, statusField.id)
    const from = fromRow ?? null
    s.pmItemValues.set(item.id, statusField.id, target)
    s.pmStatusLog.insert(item.id, from, target, null)
    s.pmItems.touch(item.id)
  }
}
