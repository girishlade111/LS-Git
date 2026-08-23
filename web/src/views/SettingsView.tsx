import { useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  ToastProvider,
  Toggle,
  useToast,
} from '../design-system'
import { SettingsNav } from '../shell/SettingsNav'

const sections = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'repository', label: 'Repository' },
  { id: 'webhooks', label: 'Webhooks' },
]

function GeneralPanel() {
  const toast = useToast()
  return (
    <section aria-label="General settings">
      <h2>General</h2>
      <p>Naming, visibility, and basic project behavior.</p>
      <div className="ds-stack" style={{ maxWidth: 480 }}>
        <Input label="Project name" defaultValue="LSGit Web" />
        <Input
          label="Project path"
          defaultValue="ls-git/web"
          hint="Changing the path redirects the old URL."
        />
        <Select
          label="Visibility"
          defaultValue="private"
          hint="Private projects are visible to members only."
          options={[
            { value: 'private', label: 'Private' },
            { value: 'internal', label: 'Internal' },
            { value: 'public', label: 'Public' },
          ]}
        />
      </div>
      <div className="ls-settings__row">
        <span>
          <h2 style={{ fontSize: 'var(--ls-fs-row)' }}>Public pipelines</h2>
          <p>Anyone can view pipeline results for public branches.</p>
        </span>
        <Toggle checked onChange={() => undefined} label="" />
      </div>
      <div className="ls-settings__row">
        <Button variant="primary" onClick={() => toast.show({ title: 'Saved', message: 'General settings updated.', variant: 'success' })}>
          Save changes
        </Button>
      </div>
    </section>
  )
}

function MembersPanel() {
  return (
    <section aria-label="Members">
      <h2>Members</h2>
      <p>People with access to this project.</p>
      <Table aria-label="Project members">
        <THead>
          <TR>
            <TH>Member</TH>
            <TH>Access level</TH>
            <TH>Expires</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>Girish Lade</TD>
            <TD><Badge variant="accent">Owner</Badge></TD>
            <TD>—</TD>
          </TR>
          <TR>
            <TD>Ada Lovelace</TD>
            <TD>Maintainer</TD>
            <TD>2026-12-31</TD>
          </TR>
        </TBody>
      </Table>
    </section>
  )
}

function RepositoryPanel() {
  const [rules, setRules] = useState({ forcePush: false })
  return (
    <section aria-label="Repository settings">
      <h2>Protected branches</h2>
      <p>Control who can push and merge into important branches.</p>
      <Table aria-label="Protected branches">
        <THead>
          <TR>
            <TH>Branch</TH>
            <TH>Allowed to push</TH>
            <TH>Allowed to merge</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>main</TD>
            <TD>Maintainers +1</TD>
            <TD>Developers +2</TD>
          </TR>
          <TR>
            <TD>release/*</TD>
            <TD>No one</TD>
            <TD>Maintainers</TD>
          </TR>
        </TBody>
      </Table>
      <div className="ds-stack">
        <Checkbox checked={!rules.forcePush} onChange={() => setRules({ forcePush: !rules.forcePush })} label="Do not allow force pushes (recommended)" />
      </div>
    </section>
  )
}

function WebhooksPanel() {
  const toast = useToast()
  const [events, setEvents] = useState({ push: true, mr: true, issue: false })
  return (
    <section aria-label="Webhook settings">
      <h2>Webhooks</h2>
      <p>POST notifications to external services on project events.</p>
      <div className="ds-stack" style={{ maxWidth: 480 }}>
        <Input label="URL" placeholder="https://example.com/hooks/lsgit" />
        <Input label="Secret token" type="password" placeholder="Used to verify deliveries" />
        <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className="ls-field__label">Trigger on</legend>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <Checkbox checked={events.push} onChange={() => setEvents((e) => ({ ...e, push: !e.push }))} label="Push events" />
            <Checkbox checked={events.mr} onChange={() => setEvents((e) => ({ ...e, mr: !e.mr }))} label="Merge request events" />
            <Checkbox checked={events.issue} onChange={() => setEvents((e) => ({ ...e, issue: !e.issue }))} label="Issue events" />
          </div>
        </fieldset>
      </div>
      <div className="ls-settings__row">
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => toast.show({ title: 'Test sent', message: 'Delivery completed with HTTP 200.', variant: 'success' })}>
            Test delivery
          </Button>
          <Button variant="primary" onClick={() => toast.show({ title: 'Saved', message: 'Webhook updated.', variant: 'success' })}>
            Save webhook
          </Button>
        </div>
      </div>
    </section>
  )
}

export function SettingsView() {
  const [current, setCurrent] = useState('general')
  return (
    <>
      <div className="ls-page-title">
        <h1>Settings</h1>
      </div>
      <p className="ls-page-desc">Project configuration for ls-git/web.</p>

      <div className="ls-settings">
        <SettingsNav items={sections} current={current} onSelect={setCurrent} />
        <div className="ls-settings__panel">
          {current === 'general' && <GeneralPanel />}
          {current === 'members' && <MembersPanel />}
          {current === 'repository' && <RepositoryPanel />}
          {current === 'webhooks' && <WebhooksPanel />}
        </div>
      </div>
    </>
  )
}
