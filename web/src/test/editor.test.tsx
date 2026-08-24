import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { unifiedDiff } from '../repository/editor/linesdiff'
import { discardDraft, listDrafts, loadDraft, saveDraft } from '../repository/editor/drafts'
import { bufferKey, editSession } from '../repository/editor/session'
import { CodeEditor } from '../repository/editor/CodeEditor'
import { CommitDialog } from '../repository/editor/CommitDialog'

// ---------------------------------------------------------------------------
// Draft persistence (local draft / restore)
// ---------------------------------------------------------------------------

describe('draft persistence', () => {
  const PROJECT = 7
  beforeEach(() => localStorage.clear())

  it('persists a draft and restores the exact content + base metadata', () => {
    saveDraft({
      projectId: PROJECT,
      path: 'docs/guide.md',
      ref: 'main',
      baseTip: 'a'.repeat(40),
      content: '# my unsaved work\n',
    })
    const draft = loadDraft(PROJECT, 'docs/guide.md')
    expect(draft).not.toBeNull()
    expect(draft!.content).toBe('# my unsaved work\n')
    expect(draft!.baseTip).toBe('a'.repeat(40))
    expect(draft!.savedAt).toBeTruthy()
  })

  it('discardDraft removes the stored work; unknown paths read as null', () => {
    saveDraft({ projectId: PROJECT, path: 'x.txt', ref: 'main', baseTip: null, content: 'hi' })
    expect(loadDraft(PROJECT, 'x.txt')).not.toBeNull()
    discardDraft(PROJECT, 'x.txt')
    expect(loadDraft(PROJECT, 'x.txt')).toBeNull()
    expect(loadDraft(PROJECT, 'never.txt')).toBeNull()
  })

  it('lists drafts per project for unsaved-changes indicators', () => {
    saveDraft({ projectId: PROJECT, path: 'a', ref: 'main', baseTip: null, content: '1' })
    saveDraft({ projectId: PROJECT, path: 'b', ref: 'main', baseTip: null, content: '2' })
    saveDraft({ projectId: 99, path: 'other', ref: 'main', baseTip: null, content: '3' })
    const drafts = listDrafts(PROJECT)
    expect(drafts.map((d) => d.path).sort()).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Multi-file editing session (foundation)
// ---------------------------------------------------------------------------

describe('editing session buffers', () => {
  beforeEach(() => {
    localStorage.clear()
    editSession.clearAll(1)
  })

  function openSample(): void {
    editSession.open({
      projectId: 1,
      ref: 'main',
      path: 'src/a.ts',
      baseContent: 'const one = 1',
      baseTip: 'b'.repeat(40),
      isNew: false,
    })
  }

  it('tracks dirty state against the loaded base content', () => {
    openSample()
    let buf = editSession.get(1, 'src/a.ts')!
    expect(editSession.isDirty(buf)).toBe(false)

    editSession.update(1, 'src/a.ts', 'const one = 2')
    buf = editSession.get(1, 'src/a.ts')!
    expect(editSession.isDirty(buf)).toBe(true)

    // The update also persisted a draft.
    expect(loadDraft(1, 'src/a.ts')!.content).toBe('const one = 2')
  })

  it('supports MULTIPLE dirty files committed together as one changeset', () => {
    openSample()
    editSession.open({
      projectId: 1, ref: 'main', path: 'new.md',
      baseContent: '', baseTip: null, isNew: true,
    })
    editSession.update(1, 'src/a.ts', 'edited')
    editSession.update(1, 'new.md', 'created')

    const dirty = editSession.dirtyBuffers()
    expect(dirty.map((b) => b.path)).toEqual(['new.md', 'src/a.ts'])

    const changes = editSession.toChanges()
    expect(changes).toContainEqual({ path: 'src/a.ts', content: 'edited' })
    expect(changes).toContainEqual({ path: 'new.md', content: 'created' })
  })

  it('clearAll drops buffers AND their drafts after a commit lands', () => {
    openSample()
    editSession.update(1, 'src/a.ts', 'work')
    editSession.clearAll(1)
    expect(editSession.list()).toHaveLength(0)
    expect(loadDraft(1, 'src/a.ts')).toBeNull()
  })

  it('buffer keys are project+path scoped', () => {
    expect(bufferKey(3, 'a/b')).toBe('3:a/b')
  })
})

// ---------------------------------------------------------------------------
// Diff preview generation
// ---------------------------------------------------------------------------

describe('diff preview (unified diff generation)', () => {
  it('produces parseable hunks with correct +/- markers and stats', () => {
    const { text, stats } = unifiedDiff(
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
      'one\ntwo\nTHREE!\nfour\nfive\nsix\nseven\neight\nNINE\nten\n',
      'f.txt',
    )
    expect(text).toContain('diff --git a/f.txt b/f.txt')
    expect(text).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m)
    expect(text).toContain('-three')
    expect(text).toContain('+THREE!')
    expect(stats).toEqual({ added: 2, removed: 2 })
  })

  it('returns empty text for identical content (nothing to preview)', () => {
    const { text, stats } = unifiedDiff('same\n', 'same\n', 'f.txt')
    expect(text).toBe('')
    expect(stats).toEqual({ added: 0, removed: 0 })
  })

  it('treats empty old text as new-file output', () => {
    const { text } = unifiedDiff('', 'brand new\n', 'n.md')
    expect(text).toContain('@@ -0,0 +1,1 @@')
    expect(text).toContain('+brand new')
  })
})

// ---------------------------------------------------------------------------
// Editor component mounting (production editor integration)
// ---------------------------------------------------------------------------

describe('CodeEditor surface', () => {
  it('mounts the production editor with initial content and quiet chrome', () => {
    const onChange = vi.fn()
    const { container } = render(<CodeEditor value={'hello world'} fileName="a.ts" onChange={onChange} />)
    expect(container.querySelector('[data-testid="code-editor"]')).toBeTruthy()
    // Content is visible inside CodeMirror's editable surface…
    expect(container.textContent).toContain('hello world')
    // …and the surface is a real editing target.
    expect(container.querySelector('[contenteditable="true"], .cm-content')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Commit workflow dialog
// ---------------------------------------------------------------------------

function makeBuffers() {
  return [
    {
      key: '5:README.md',
      projectId: 5,
      ref: 'main',
      path: 'README.md',
      baseContent: '# old\n',
      baseTip: 'c'.repeat(40),
      content: '# new\n',
      isNew: false,
    },
  ]
}

function csrfCookieSetup(): void {
  document.cookie = 'lsgit_csrf=testtoken; Path=/'
}

describe('commit workflow', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'lsgit_csrf=; Max-Age=0'
  })

  it('commits to the CURRENT branch with expected_base_tip (optimistic concurrency)', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commit_sha: 'f'.repeat(40), branch: 'main', created_branch: false,
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const onCommitted = vi.fn()
    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={onCommitted}
      />,
    )

    await user.type(screen.getByLabelText(/Commit message/i), 'my message')
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(onCommitted).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.branch).toBe('main')
    expect(body.expected_base_tip).toBe('c'.repeat(40)) // stale-commit guard sent
    expect(body.commit_message).toBe('my message')

    vi.unstubAllGlobals()
  })

  it('supports committing to a NEW BRANCH (future-MR-ready flow)', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commit_sha: 'e'.repeat(40), branch: 'patch-1', created_branch: true,
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={() => undefined}
      />,
    )
    await user.click(screen.getByLabelText(/Create new branch/i))
    await user.type(screen.getByLabelText('New branch name'), 'patch-1')
    await user.type(screen.getByLabelText(/Commit message/i), 'branch commit')
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(screen.getByText(/Changes committed/)).toBeTruthy())
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.new_branch).toBe('patch-1')
    expect(body.start_branch).toBe('main')
    expect(screen.getByText(/Merge requests arrive with the collaboration phase/)).toBeTruthy()

    vi.unstubAllGlobals()
  })

  it('STALE COMMIT: shows an explicit conflict panel — never silent overwrite', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'The branch changed while you were editing',
      code: 'ref_update_conflict',
      expected: 'c'.repeat(40),
      current: 'd'.repeat(40),
    }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)

    const onCommitted = vi.fn()
    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={onCommitted}
      />,
    )
    await user.type(screen.getByLabelText(/Commit message/i), 'stale attempt')
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/changed while you were editing/)).toBeTruthy()
    expect(onCommitted).not.toHaveBeenCalled() // nothing was treated as success

    // Recovery path offered: re-target to a new branch.
    expect(screen.getByRole('button', { name: /new branch/i })).toBeTruthy()

    vi.unstubAllGlobals()
  })

  it('PERMISSION DENIAL surfaces inline without losing the draft', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'You are not allowed to write to this repository',
    }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    saveDraft({ projectId: 5, path: 'README.md', ref: 'main', baseTip: null, content: '# new\n' })
    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={() => undefined}
      />,
    )
    await user.type(screen.getByLabelText(/Commit message/i), 'nope')
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not allowed'))
    // The draft survives locally so no work is lost.
    expect(loadDraft(5, 'README.md')!.content).toBe('# new\n')

    vi.unstubAllGlobals()
  })

  it('PROTECTED BRANCH rejection is shown with the server reason', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "Branch 'main' is protected — the operation was rejected",
      code: 'protected_branch',
    }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={() => undefined}
      />,
    )
    await user.type(screen.getByLabelText(/Commit message/i), 'blocked push')
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('protected'),
    )
    vi.unstubAllGlobals()
  })

  it('LARGE FILE rejection from the server is displayed (413 too_large)', async () => {
    csrfCookieSetup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'File exceeds the 50 MB limit', code: 'too_large',
    }), { status: 413 }))
    vi.stubGlobal('fetch', fetchMock)

    const bigBuffer = [{ ...makeBuffers()[0]!, content: 'x'.repeat(60) }]
    const user = userEvent.setup()
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={bigBuffer}
        defaultBranch="main"
        onCommitted={() => undefined}
      />,
    )
    await user.type(screen.getByLabelText(/Commit message/i), 'too big')
    await user.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('exceeds'))
    vi.unstubAllGlobals()
  })

  it('shows the diff preview for staged buffers before committing', () => {
    render(
      <CommitDialog
        open
        onClose={() => undefined}
        buffers={makeBuffers()}
        defaultBranch="main"
        onCommitted={() => undefined}
      />,
    )
    const region = screen.getByLabelText('Diff preview')
    expect(region.textContent).toContain('-# old')
    expect(region.textContent).toContain('+# new')
  })
})
