import { useState } from 'react'
import {
  ActivityItem,
  Avatar,
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  Combobox,
  Dialog,
  DiffViewer,
  Drawer,
  Dropdown,
  EmptyState,
  IconButton,
  Input,
  Pagination,
  Select,
  Skeleton,
  StatusIndicator,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  Textarea,
  ToastProvider,
  Toggle,
  Tooltip,
  useToast,
} from '../design-system'

const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index 83db48f..bf269f4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,6 +1,8 @@
 import { start } from './server'
+import { config } from './config'
 
-function main() {
-  start({ port: 3000 })
+function main() {
+  const cfg = config.load()
+  start(cfg)
 }`

const swatches: Array<{ token: string; hex: string }> = [
  { token: '--ls-bg', hex: '#0d0d0d' },
  { token: '--ls-panel', hex: '#161616' },
  { token: '--ls-surface-1', hex: '#1c1c1c' },
  { token: '--ls-surface-2', hex: '#242424' },
  { token: '--ls-border', hex: '#2a2a2a' },
  { token: '--ls-text', hex: '#e8e8e8' },
  { token: '--ls-text-secondary', hex: '#8a8a8a' },
  { token: '--ls-accent', hex: '#e07856' },
  { token: '--ls-success', hex: '#3ecf5e' },
  { token: '--ls-danger', hex: '#e5484d' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ls-section" aria-label={title}>
      <h2 className="ls-section__title">{title}</h2>
      <div className="ls-card" style={{ padding: 16 }}>
        {children}
      </div>
    </section>
  )
}

function Playground() {
  const toast = useToast()
  const [tab, setTab] = useState('code')
  const [dialog, setDialog] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [combo, setCombo] = useState<string | null>('dev')
  const [page, setPage] = useState(4)
  const [flag, setFlag] = useState(true)
  const [check, setCheck] = useState(true)

  return (
    <>
      <div className="ls-page-title">
        <h1>Design system</h1>
      </div>
      <p className="ls-page-desc">Token-driven primitives. Every value resolves from tokens.css.</p>

      <Section title="Color tokens">
        <div className="ds-row">
          {swatches.map((s) => (
            <span key={s.token} className="swatch">
              <i style={{ background: `var(${s.token})` }} />
              {s.hex}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Buttons">
        <div className="ds-row">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Add item" icon="plus" />
        </div>
      </Section>

      <Section title="Inputs">
        <div className="ds-stack">
          <Input label="Project name" placeholder="my-project" hint="Lowercase letters, digits, dashes." />
          <Input label="Email" defaultValue="not-an-email" error="Enter a valid email address." />
          <Textarea label="Description" rows={3} placeholder="Optional description…" />
          <Select
            label="Default branch"
            options={[
              { value: 'main', label: 'main' },
              { value: 'master', label: 'master' },
            ]}
            defaultValue="main"
          />
          <Combobox
            label="Assignee"
            value={combo}
            onChange={setCombo}
            placeholder="Search members…"
            options={[
              { value: 'dev', label: 'Girish Lade', description: '@girish' },
              { value: 'ada', label: 'Ada Lovelace', description: '@ada' },
              { value: 'linus', label: 'Linus Torvalds', description: '@linus' },
            ]}
          />
          <Checkbox checked={check} onChange={setCheck} label="Enable CI/CD for this project" />
          <Toggle checked={flag} onChange={setFlag} label="Public pipelines" />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          aria-label="Demo tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'code', label: 'Code', content: <p style={{ padding: '12px 0', color: 'var(--ls-text-secondary)' }}>Code panel content.</p> },
            { id: 'ci', label: 'CI/CD', content: <p style={{ padding: '12px 0', color: 'var(--ls-text-secondary)' }}>Pipeline runs appear here.</p> },
            { id: 'sec', label: 'Security', content: <p style={{ padding: '12px 0', color: 'var(--ls-text-secondary)' }}>Scan results appear here.</p> },
          ]}
        />
      </Section>

      <Section title="Overlays & feedback">
        <div className="ds-row">
          <Tooltip content="Opens a modal dialog">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
          </Tooltip>
          <Button onClick={() => setDrawer(true)}>Open drawer</Button>
          <Dropdown
            menuLabel="More actions"
            trigger={({ onClick, 'aria-expanded': expanded }) => (
              <Button iconEnd="chevron-down" aria-expanded={expanded} onClick={onClick}>
                Actions
              </Button>
            )}
            items={[
              { kind: 'item', id: 'archive', label: 'Archive project' },
              { kind: 'item', id: 'transfer', label: 'Transfer project' },
              { kind: 'separator' },
              { kind: 'item', id: 'delete', label: 'Delete project', icon: 'trash' },
            ]}
          />
          <Button variant="primary" onClick={() => toast.show({ title: 'Saved', message: 'Project settings updated.', variant: 'success' })}>
            Show success toast
          </Button>
          <Button variant="danger" onClick={() => toast.show({ title: 'Failed', message: 'Could not reach runner.', variant: 'danger' })}>
            Show error toast
          </Button>
        </div>

        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Delete project?"
          description="This permanently deletes the repository and all associated data. This action cannot be undone."
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" data-autofocus onClick={() => setDialog(false)}>
                Delete project
              </Button>
            </>
          }
        >
          <p>Type the project path to confirm.</p>
        </Dialog>

        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Keyboard shortcuts" side="right">
          <ul style={{ display: 'grid', gap: 8, fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>
            <li><kbd>Ctrl K</kbd> — Search</li>
            <li><kbd>g p</kbd> — Go to projects</li>
            <li><kbd>Esc</kbd> — Close overlays</li>
          </ul>
        </Drawer>
      </Section>

      <Section title="Data display">
        <Table aria-label="Example table">
          <THead>
            <TR>
              <TH>Pipeline</TH>
              <TH>Status</TH>
              <TH>Duration</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>#1204 main</TD>
              <TD><StatusIndicator status="success" /></TD>
              <TD>4m 12s</TD>
            </TR>
            <TR>
              <TD>#1203 feat/diff-viewer</TD>
              <TD><StatusIndicator status="failed" /></TD>
              <TD>2m 03s</TD>
            </TR>
          </TBody>
        </Table>
        <div style={{ marginTop: 12 }}>
          <Pagination page={page} pageCount={12} onChange={setPage} />
        </div>
        <div className="ds-row">
          <Badge>neutral</Badge>
          <Badge variant="accent">accent</Badge>
          <Badge variant="success">success</Badge>
          <Badge variant="danger">danger</Badge>
          <Avatar name="Girish Lade" />
          <Avatar name="Ada Lovelace" size="sm" />
          <StatusIndicator status="running" label="Deploying" />
          <Skeleton width={140} height={10} shape="text" />
          <Skeleton width={28} height={28} shape="circle" />
        </div>
      </Section>

      <Section title="Empty state">
        <EmptyState
          icon="merge"
          title="No merge requests"
          description="Merge requests let you review and collaborate on code changes."
          action={<Button variant="primary" size="sm">New merge request</Button>}
        />
      </Section>

      <Section title="Code & diff">
        <CodeBlock filename="src/server.ts" code={'import { createServer } from "node:http"\n\nexport function start(port: number) {\n  createServer().listen(port)\n}\n'} />
        <div style={{ height: 16 }} />
        <DiffViewer diff={sampleDiff} />
      </Section>

      <Section title="Activity">
        <ActivityItem
          leading={<Avatar name="Girish Lade" size="sm" />}
          title={<>Girish pushed to <strong>main</strong></>}
          description="3 commits · tokens.css +142 −0"
          meta={<><span style={{ display: 'inline-flex', verticalAlign: '-3px' }} /><span>2m ago</span></>}
        />
      </Section>
    </>
  )
}

export function DesignSystemView() {
  return (
    <ToastProvider>
      <Playground />
    </ToastProvider>
  )
}
