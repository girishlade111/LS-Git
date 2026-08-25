import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IssuesListPage } from '../issues/IssuesListPage'
import { FormsManagerView } from '../issues/FormsManagerView'

/**
 * UI coverage for issue-form flows: form selection in the create dialog,
 * dynamic field rendering per type, client-side required validation, the
 * submission payload shape, and the maintainer forms manager.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const FORM = {
  name: 'Bug report',
  description: 'Report a reproducible problem',
  title_prefix: '[bug] ',
  title_field: 'summary',
  labels: ['bug'],
  fields: [
    {
      type: 'text', id: 'summary', label: 'Summary', description: 'One line', placeholder: 'Login returns 500',
      multiple: false, default_value: null, options: [],
      validations: { required: true, min_length: null, max_length: null, pattern_message: null },
    },
    {
      type: 'dropdown', id: 'severity', label: 'Severity', description: '', placeholder: '',
      multiple: false, default_value: null,
      options: [
        { label: 'low', description: '', required: false },
        { label: 'high', description: '', required: false },
      ],
      validations: { required: true, min_length: null, max_length: null, pattern_message: null },
    },
    {
      type: 'checkboxes', id: 'environment', label: 'Environment', description: '', placeholder: '',
      multiple: false, default_value: null,
      options: [
        { label: 'On staging', description: '', required: true },
        { label: 'In production', description: '', required: false },
      ],
      validations: { required: false, min_length: null, max_length: null, pattern_message: null },
    },
    {
      type: 'tasklist', id: 'triage', label: 'Triage steps', description: '', placeholder: '',
      multiple: false, default_value: null,
      options: [{ label: 'collect logs', description: '', required: false }],
      validations: { required: false, min_length: null, max_length: null, pattern_message: null },
    },
  ],
} as const

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

const NAV = (to: string) => void to

describe('form-driven issue creation', () => {
  it('selects a form, renders its fields and SUBMITS the answers payload', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/issue_forms/') && method === 'GET' && u.endsWith('bug_report')) {
        return Promise.resolve(jsonResponse({ form: FORM }))
      }
      if (u.endsWith('/submissions') && method === 'POST') {
        return Promise.resolve(jsonResponse({ issue: { web_path: '/proj/alice/web/issues/9' } }, 201))
      }
      if (u.includes('/issue_forms')) return Promise.resolve(jsonResponse({ forms: [{ name: 'bug_report', title: 'Bug report', description: '', field_count: 4, valid: true }] }))
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse({ issues: [], pagination: { page: 1, per_page: 20, total: 0, total_pages: 1, has_more: false } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<IssuesListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} />)

    await user.click(screen.getByRole('button', { name: /New issue/ }))
    // Only one mode button is enabled when no forms exist — with a form present both are.
    const useForm = await screen.findByRole('radio', { name: /Use a form/ })
    expect(useForm).not.toHaveProperty('disabled', true)
    await user.click(useForm)

    await user.selectOptions(await screen.findByRole('combobox', { name: /^Form$/ }), 'bug_report')
    expect(await screen.findByText('One line')).toBeTruthy()

    await fireEvent.change(await screen.findByRole('textbox', { name: 'Summary' }), { target: { value: 'Crash on save' } })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'high')
    await user.click(screen.getByRole('checkbox', { name: /^On staging/ }))
    await user.click(screen.getByRole('checkbox', { name: /collect logs/ }))

    await user.click(screen.getByRole('button', { name: 'Submit form' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith('/submissions') && (c[1] as RequestInit).method === 'POST',
      )
      expect(posts.length).toBe(1)
      const body = JSON.parse(String((posts[0]![1] as RequestInit).body)) as Record<string, unknown>
      expect(body.title).toBeUndefined() // no explicit title → title_field wins server-side
      const answers = body.answers as Record<string, unknown>
      expect(answers.summary).toBe('Crash on save')
      expect(answers.severity).toBe('high')
      expect(answers.environment).toEqual(['On staging'])
      expect(answers.triage).toEqual(['collect logs'])
    })
  })

  it('blocks submission CLIENT-SIDE while required fields are empty', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/issue_forms/') && !u.endsWith('bug_report')) return Promise.resolve(jsonResponse({ forms: [] }))
      if (u.endsWith('bug_report')) return Promise.resolve(jsonResponse({ form: FORM }))
      if (u.includes('/issue_forms')) return Promise.resolve(jsonResponse({ forms: [{ name: 'bug_report', title: 'Bug report', description: '', field_count: 4, valid: true }] }))
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse({ issues: [], pagination: { page: 1, per_page: 20, total: 0, total_pages: 1, has_more: false } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<IssuesListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} />)
    await user.click(screen.getByRole('button', { name: /New issue/ }))
    await user.click(await screen.findByRole('radio', { name: /Use a form/ }))
    await user.selectOptions(await screen.findByRole('combobox', { name: /^Form$/ }), 'bug_report')

    const submit = await screen.findByRole('button', { name: 'Submit form' })
    await waitFor(() => expect(submit).toBeTruthy())

    // Fill only SOME required fields; submission stays blocked + error shows.
    await fireEvent.change(await screen.findByRole('textbox', { name: 'Summary' }), { target: { value: 'Crash on save' } })
    expect(submit).toHaveProperty('disabled', true)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'low')
    expect(submit).toHaveProperty('disabled', false)

    // No POST was ever sent while invalid.
    const posts = fetchMock.mock.calls.filter(
      (c) => String(c[0]).endsWith('/submissions') && (c[1] as RequestInit).method === 'POST',
    )
    expect(posts.length).toBe(0)
  })
})

describe('forms manager view', () => {
  it('lists templates with validity state and saves NEW templates as YAML', async () => {
    let stored: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const u = String(_url)
      if (method === 'PUT') {
        const payload = JSON.parse(String(init?.body)) as { yaml: string }
        stored.push({ name: 'perf_report', yaml: payload.yaml })
        return Promise.resolve(jsonResponse({ path: '.lsgit/issues/forms/perf_report.yml', commit_sha: 'abc123', form: { name: 'Perf report', fields: [] } }))
      }
      if (u.includes('/issue_forms')) return Promise.resolve(jsonResponse({ forms: [...stored.map((f) => ({
        name: f.name, title: f.name, description: '', field_count: 2, valid: true,
      }))] }))
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<FormsManagerView projectId={5} />)

    // Wait for the initial load before interacting.
    await user.click(await screen.findByRole('button', { name: /New form/ }))
    const editor = await screen.findByLabelText(/Template YAML/)
    // The editor opens pre-seeded with an LSGit-native schema skeleton.
    expect(editor.value).toContain('fields:')
    expect(editor.value).toContain('- type: text')

    await fireEvent.change(screen.getByLabelText(/File name/i), { target: { value: 'perf_report' } })
    await user.click(screen.getByRole('button', { name: /Save to repository/ }))

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit).method === 'PUT')
      expect(puts.length).toBe(1)
      expect(String(puts[0]![0])).toContain('/issue_forms/perf_report')
    })
  })

  it('shows INVALID stored templates with their parse errors instead of crashing', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/issue_forms')) {
        return Promise.resolve(jsonResponse({
          forms: [
            { name: 'broken', title: 'broken', description: '', field_count: 0, valid: false, error: 'YAML tags are not supported and are rejected outright' },
          ],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    }))
    render(<FormsManagerView projectId={5} />)
    await waitFor(() => expect(screen.getByText('invalid')).toBeTruthy())
    expect(screen.getByText(/YAML tags are not supported/)).toBeTruthy()
  })
})
