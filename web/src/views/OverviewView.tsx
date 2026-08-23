import { useState } from 'react'
import { Button } from '../design-system/Button'
import {
  ActivityItem,
  Avatar,
  Badge,
  CodeBlock,
  EmptyState,
  FileTree,
  StatusIndicator,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type FileTreeNode,
} from '../design-system'

const tree: FileTreeNode[] = [
  {
    name: 'web',
    path: 'web',
    type: 'dir',
    children: [
      { name: 'index.html', path: 'web/index.html', type: 'file' },
      {
        name: 'src',
        path: 'web/src',
        type: 'dir',
        children: [
          { name: 'main.tsx', path: 'web/src/main.tsx', type: 'file' },
          { name: 'tokens.css', path: 'web/src/tokens.css', type: 'file' },
        ],
      },
    ],
  },
  { name: '.gitignore', path: '.gitignore', type: 'file' },
  { name: 'README.md', path: 'README.md', type: 'file' },
]

const fileContents: Record<string, string> = {
  'README.md': '# LSGit\n\nDeveloper-first Git hosting.\n',
  '.gitignore': 'node_modules/\ndist/\n',
}

export function OverviewView() {
  const [selected, setSelected] = useState<string | null>('README.md')

  return (
    <>
      <div className="ls-page-title">
        <h1>Overview</h1>
        <Button size="sm" variant="primary" iconStart="plus" onClick={() => { window.location.hash = '/projects/new' }}>
          New project
        </Button>
      </div>
      <p className="ls-page-desc">Repository files, recent activity, and branch health.</p>

      <section className="ls-section" aria-label="Code">
        <h2 className="ls-section__title">Code</h2>
        <div className="ls-grid-2">
          <FileTree
            nodes={tree}
            selectedPath={selected}
            ariaLabel="Project files"
            onSelect={(node) => setSelected(node.path)}
          />
          {selected && fileContents[selected] ? (
            <CodeBlock filename={selected} code={fileContents[selected]} />
          ) : (
            <EmptyState
              icon="file"
              title="No preview available"
              description="Binary and large files are not previewed in this demo."
            />
          )}
        </div>
      </section>

      <section className="ls-section" aria-label="Branches">
        <h2 className="ls-section__title">Branches</h2>
        <Table aria-label="Active branches">
          <THead>
            <TR>
              <TH>Branch</TH>
              <TH>Last commit</TH>
              <TH>Updated</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>main</TD>
              <TD>Add design tokens</TD>
              <TD>2 hours ago</TD>
              <TD>
                <StatusIndicator status="success" />
              </TD>
            </TR>
            <TR>
              <TD>
                feat/combobox <Badge variant="accent">protected</Badge>
              </TD>
              <TD>Wire aria-activedescendant</TD>
              <TD>Yesterday</TD>
              <TD>
                <StatusIndicator status="running" label="CI running" />
              </TD>
            </TR>
            <TR>
              <TD>fix/sidebar-scroll</TD>
              <TD>Overflow fix</TD>
              <TD>3 days ago</TD>
              <TD>
                <StatusIndicator status="failed" label="Checks failed" />
              </TD>
            </TR>
          </TBody>
        </Table>
      </section>

      <section className="ls-section" aria-label="Recent activity">
        <h2 className="ls-section__title">Recent activity</h2>
        <div className="ls-card" style={{ padding: '4px 14px' }}>
          <ActivityItem
            leading={<Avatar name="Girish Lade" size="sm" />}
            title={
              <>
                Girish pushed to <strong>main</strong>
              </>
            }
            description="Add design-system foundation · e07856f"
            meta="2h ago"
          />
          <ActivityItem
            leading={<Avatar name="Ada Lovelace" size="sm" />}
            title={
              <>
                Ada opened merge request <strong>#42</strong>
              </>
            }
            description="Combobox keyboard navigation"
            meta="5h ago"
          />
          <ActivityItem
            leading={<Avatar name="Linus T" size="sm" />}
            title={
              <>
                Linus commented on issue <strong>#17</strong>
              </>
            }
            description="Reproduced on Windows; stack trace attached."
            meta="yesterday"
          />
        </div>
      </section>
    </>
  )
}
