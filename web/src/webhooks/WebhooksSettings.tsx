import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Checkbox } from '../design-system/Checkbox'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Table, TBody, TD, TH, THead, TR } from '../design-system/Table'
import { Toggle } from '../design-system/Toggle'
import {
  webhooksApi,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_LABELS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from './api'

/**
 * Project webhooks management inside Settings (GitLab Settings → Webhooks).
 * Uses the LSGit settings-list design language: section title → card →
 * dense table rows, with `.ls-settings__row` blocks for destructive/advanced
 * entries. All deliveries are asynchronous server-side — "Test" only queues.
 */

type Notify = (title: string, message?: string, variant?: 'info' | 'success' | 'danger') => void

const STATE_BADGE: Record<Webhook['state'], { variant: 'success' | 'neutral' | 'danger'; label: string }> = {
  enabled: { variant: 'success', label: 'Enabled' },
  disabled: { variant: 'neutral', label: 'Disabled' },
  auto_disabled: { variant: 'danger', label: 'Auto-disabled' },
}

const DELIVERY_BADGE: Record<WebhookDelivery['state'], { variant: 'success' | 'accent' | 'danger'; label: string }> = {
  delivered: { variant: 'success', label: 'Delivered' },
  pending: { variant: 'accent', label: 'Pending' },
  retrying: { variant: 'accent', label: 'Retrying' },
  failed: { variant: 'danger', label: 'Failed' },
}

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

interface EditorForm {
  name: string
  url: string
  description: string
  ssl_verify: boolean
  events: Set<WebhookEvent>
}

const ALL_EVENTS = (): Set<WebhookEvent> => new Set<WebhookEvent>(['push'])

export function WebhooksSection({ projectId, notify }: { projectId: number; notify: Notify }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<EditorForm>({ name: '', url: '', description: '', ssl_verify: true, events: ALL_EVENTS() })

  // Shown exactly once after create/rotate — the server stores only digests.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)

  const [historyHook, setHistoryHook] = useState<Webhook | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [deliveryDetail, setDeliveryDetail] = useState<(WebhookDelivery & { response_snippet?: string | null }) | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null)

  async function reload() {
    try {
      setHooks((await webhooksApi.list(projectId)).webhooks ?? [])
    } catch (e) {
      notify('Failed to load webhooks', e instanceof Error ? e.message : undefined, 'danger')
    }
  }
  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [projectId])

  async function mutate(fn: () => Promise<unknown>, okTitle: string, okMessage?: string): Promise<boolean> {
    try {
      await fn()
      await reload()
      if (okTitle) notify(okTitle, okMessage, 'success')
      return true
    } catch (e) {
      notify('Failed', e instanceof Error ? e.message : undefined, 'danger')
      return false
    }
  }

  function openCreate() {
    setEditId(null)
    setForm({ name: '', url: '', description: '', ssl_verify: true, events: ALL_EVENTS() })
    setRevealedSecret(null)
    setEditorOpen(true)
  }

  function openEdit(h: Webhook) {
    setEditId(h.id)
    setForm({ name: h.name, url: h.url, description: h.description, ssl_verify: h.ssl_verify, events: new Set(h.events) })
    setRevealedSecret(null)
    setEditorOpen(true)
  }

  async function submitEditor() {
    const payload = {
      name: form.name,
      description: form.description,
      url: form.url.trim(),
      ssl_verify: form.ssl_verify,
      events: [...form.events],
    }
    if (editId !== null) {
      const done = await mutate(() => webhooksApi.update(projectId, editId, payload), 'Saved', 'Webhook updated.')
      if (done) setEditorOpen(false)
      return
    }
    try {
      const created = await webhooksApi.create(projectId, payload)
      await reload()
      setEditorOpen(false)
      setRevealedSecret(created.secret) // keep the dialog open on the one-time secret step
    } catch (e) {
      notify('Failed', e instanceof Error ? e.message : undefined, 'danger')
    }
  }

  async function rotate(h: Webhook) {
    try {
      const r = await webhooksApi.rotateSecret(projectId, h.id)
      setEditId(h.id)
      setForm({ name: h.name, url: h.url, description: h.description, ssl_verify: h.ssl_verify, events: new Set(h.events) })
      setRevealedSecret(r.secret)
      notify('Secret rotated', 'Update your receiver with the new token.', 'info')
    } catch (e) {
      notify('Failed', e instanceof Error ? e.message : undefined, 'danger')
    }
  }

  async function openHistory(h: Webhook) {
    setHistoryHook(h)
    setDeliveryDetail(null)
    setDeliveries(null)
    try {
      setDeliveries((await webhooksApi.deliveries(projectId, h.id)).deliveries)
    } catch (e) {
      notify('Failed', e instanceof Error ? e.message : undefined, 'danger')
    }
  }

  async function openDetail(d: WebhookDelivery) {
    if (!historyHook) return
    try {
      setDeliveryDetail((await webhooksApi.delivery(projectId, historyHook.id, d.id)).delivery)
    } catch (e) {
      notify('Failed', e instanceof Error ? e.message : undefined, 'danger')
    }
  }

  async function replay(d: WebhookDelivery) {
    if (!historyHook) return
    const done = await mutate(
      () => webhooksApi.replay(projectId, historyHook.id, d.id),
      'Replay queued',
      'The delivery was re-enqueued.',
    )
    if (done) {
      setDeliveries((await webhooksApi.deliveries(projectId, historyHook!.id)).deliveries)
    }
  }

  return (
    <>
      <h2 className="ls-section__title">Webhooks</h2>
      <section className="ls-card" style={{ padding: 20 }} aria-label="Webhook settings">
        <p style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)', marginTop: 0 }}>
          POST notifications to external services when things happen in this project.
          Deliveries are signed with HMAC-SHA256 and retried automatically.
        </p>

        <div className="ls-settings__row" style={{ borderTop: 'none' }}>
          <span />
          <Button size="sm" variant="primary" iconStart="plus" onClick={openCreate}>
            New webhook
          </Button>
        </div>

        {hooks === null ? null : hooks.length === 0 ? (
          <EmptyState icon="bell" title="No webhooks" description="Add a hook URL to start receiving project events." />
        ) : (
          <Table aria-label="Project webhooks">
            <THead>
              <TR>
                <TH>Webhook</TH>
                <TH>Events</TH>
                <TH>Status</TH>
                <TH>Last delivery</TH>
                <TH><span className="ls-sr-only">Actions</span></TH>
              </TR>
            </THead>
            <TBody>
              {hooks.map((h) => (
                <TR key={h.id}>
                  <TD>
                    <div>{h.name || '(unnamed)'}</div>
                    <code style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 'var(--ls-fs-label)' }}>{h.url}</code>
                  </TD>
                  <TD>
                    <span className="ds-row" style={{ flexWrap: 'wrap', gap: 4 }}>
                      {h.events.map((e) => <Badge key={e}>{e}</Badge>)}
                    </span>
                  </TD>
                  <TD>
                    <Badge variant={STATE_BADGE[h.state].variant}>{STATE_BADGE[h.state].label}</Badge>
                    {h.disabled_reason && (
                      <div style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-text-secondary)' }}>{h.disabled_reason}</div>
                    )}
                    {h.consecutive_failures > 0 && h.state === 'enabled' && (
                      <div style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-danger)' }}>
                        {h.consecutive_failures} consecutive failure{h.consecutive_failures === 1 ? '' : 's'}
                      </div>
                    )}
                  </TD>
                  <TD className="ls-rb__muted">{dayOf(h.last_delivery_at)}</TD>
                  <TD className="ls-labels__actions">
                    <IconButton label={`Test ${h.url}`} icon="bell" onClick={() =>
                      void mutate(
                        () => webhooksApi.test(projectId, h.id),
                        'Test queued',
                        'A test delivery was enqueued.',
                      )
                    } />
                    <IconButton label={`Delivery history ${h.url}`} icon="clock" onClick={() => void openHistory(h)} />
                    <IconButton label={`Rotate secret ${h.url}`} icon="key" onClick={() => void rotate(h)} />
                    <IconButton label={`Edit ${h.url}`} icon="settings" onClick={() => openEdit(h)} />
                    {h.state !== 'enabled' && (
                      <IconButton label={`Enable ${h.url}`} icon="check" onClick={() =>
                        void mutate(
                          () => webhooksApi.update(projectId, h.id, { state_event: 'enable' }),
                          'Enabled',
                          'The webhook is active again.',
                        )
                      } />
                    )}
                    {h.state === 'enabled' && (
                      <IconButton label={`Disable ${h.url}`} icon="close" onClick={() =>
                        void mutate(
                          () => webhooksApi.update(projectId, h.id, { state_event: 'disable' }),
                          'Disabled',
                          undefined,
                        )
                      } />
                    )}
                    <IconButton label={`Delete ${h.url}`} icon="trash" onClick={() => setDeleteTarget(h)} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      {/* ── Create / edit / one-time secret ── */}
      <Dialog
        open={editorOpen || revealedSecret !== null}
        onClose={() => { setEditorOpen(false); setRevealedSecret(null); void reload() }}
        title={editId !== null ? 'Edit webhook' : revealedSecret ? 'Copy your secret token' : 'New webhook'}
        description={
          editId !== null
            ? undefined
            : revealedSecret
              ? 'This token is shown ONCE — it signs every delivery so receivers can verify authenticity.'
              : 'Choose a receiver URL and the events that should trigger deliveries.'
        }
        footer={
          revealedSecret ? (
            <Button variant="primary" data-autofocus onClick={() => { setRevealedSecret(null); setEditorOpen(false) }}>
              Done — I saved the token
            </Button>
          ) : (
            <>
              <Button onClick={() => { setEditorOpen(false); void reload() }}>Cancel</Button>
              <Button
                variant="primary"
                data-autofocus
                disabled={!form.url.trim() || form.events.size === 0}
                onClick={() => void submitEditor()}
              >
                {editId !== null ? 'Save changes' : 'Create webhook'}
              </Button>
            </>
          )
        }
      >
        {revealedSecret ? (
          <code style={{ fontFamily: 'var(--ls-font-mono)', wordBreak: 'break-all' }}>{revealedSecret}</code>
        ) : (
          <div className="ds-stack">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="CI bridge" />
            <Input
              label="URL"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://example.com/hooks/lsgit"
              hint={form.ssl_verify ? 'HTTPS required while SSL verification is on.' : undefined}
            />
            <Input label="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <Toggle checked={form.ssl_verify} onChange={(v) => setForm({ ...form, ssl_verify: v })} label="SSL verification" />
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-text-secondary)' }}>Trigger on</legend>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {WEBHOOK_EVENTS.map((e) => (
                  <Checkbox
                    key={e}
                    label={WEBHOOK_EVENT_LABELS[e]}
                    checked={form.events.has(e)}
                    onChange={(ev) => {
                      const next = new Set(form.events)
                      if ((ev.target as HTMLInputElement).checked) next.add(e)
                      else next.delete(e)
                      setForm({ ...form, events: next })
                    }}
                  />
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </Dialog>

      {/* ── Delivery history ── */}
      <Dialog
        open={historyHook !== null}
        onClose={() => { setHistoryHook(null); setDeliveries(null); setDeliveryDetail(null) }}
        title={deliveryDetail ? 'Delivery detail' : `Recent deliveries — ${historyHook?.name || historyHook?.url || ''}`}
        description={deliveryDetail ? undefined : 'Latest attempts, newest first.'}
        footer={
          deliveryDetail ? (
            <>
              <Button onClick={() => setDeliveryDetail(null)}>Back</Button>
              <Button
                data-autofocus
                disabled={deliveryDetail.state === 'pending' || deliveryDetail.state === 'retrying'}
                onClick={() => void replay(deliveryDetail)}
              >
                Replay delivery
              </Button>
            </>
          ) : undefined
        }
      >
        {deliveryDetail ? (
          <div className="ds-stack">
            <p>
              <Badge variant={DELIVERY_BADGE[deliveryDetail.state].variant}>{DELIVERY_BADGE[deliveryDetail.state].label}</Badge>
              {' '}· attempts {deliveryDetail.attempts}
              {deliveryDetail.response_status != null && <> · HTTP {deliveryDetail.response_status}</>}
              {deliveryDetail.duration_ms != null && <> · {deliveryDetail.duration_ms} ms</>}
            </p>
            {deliveryDetail.error && <p role="alert" style={{ color: 'var(--ls-danger)' }}>{deliveryDetail.error}</p>}
            {deliveryDetail.response_snippet && (
              <>
                <strong style={{ fontSize: 'var(--ls-fs-label)' }}>Response</strong>
                <pre className="ls-code" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{deliveryDetail.response_snippet}</pre>
              </>
            )}
            <strong style={{ fontSize: 'var(--ls-fs-label)' }}>Request body</strong>
            <pre className="ls-code" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
              {JSON.stringify(deliveryDetail.request_body, null, 2)}
            </pre>
          </div>
        ) : !deliveries ? (
          <div role="status">Loading deliveries…</div>
        ) : deliveries.length === 0 ? (
          <EmptyState icon="clock" title="No deliveries yet" description="Trigger an event or send a test delivery." />
        ) : (
          <Table aria-label="Webhook delivery history">
            <THead>
              <TR>
                <TH>Status</TH>
                <TH>Event</TH>
                <TH>Response</TH>
                <TH>Attempts</TH>
                <TH>Date</TH>
              </TR>
            </THead>
            <TBody>
              {deliveries.map((d) => (
                <TR key={d.id} style={{ cursor: 'pointer' }} onClick={() => void openDetail(d)}>
                  <TD><Badge variant={DELIVERY_BADGE[d.state].variant}>{DELIVERY_BADGE[d.state].label}</Badge></TD>
                  <TD>{d.event_type}</TD>
                  <TD className="ls-rb__muted">{d.response_status ?? d.error?.slice(0, 40) ?? '—'}</TD>
                  <TD className="ls-rb__muted">{d.attempts}</TD>
                  <TD className="ls-rb__muted">{dayOf(d.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Dialog>

      {/* ── Delete ── */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete this webhook?"
        description="Receivers stop receiving events immediately. The delivery history is removed too."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (target) void mutate(() => webhooksApi.remove(projectId, target.id), 'Deleted', 'Webhook removed.')
              }}
            >
              Delete webhook
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </>
  )
}
