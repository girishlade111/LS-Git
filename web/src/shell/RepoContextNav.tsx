import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dropdown, type MenuItem } from '../design-system/Dropdown'
import { IconButton } from '../design-system/IconButton'

export interface RepoContextNavProps {
  group: string
  project: string
  visibility: 'Private' | 'Internal' | 'Public'
  tabs: Array<{ id: string; label: string; count?: number }>
  currentTab: string
  onTab: (id: string) => void
  onOpenMobileNav: () => void
}

/** Top context area: breadcrumb, repo actions, and repository context navigation. */
export function RepoContextNav({
  group,
  project,
  visibility,
  tabs,
  currentTab,
  onTab,
  onOpenMobileNav,
}: RepoContextNavProps) {
  const cloneItems: MenuItem[] = [
    { kind: 'item', id: 'https', label: 'Clone with HTTPS' },
    { kind: 'item', id: 'ssh', label: 'Clone with SSH' },
    { kind: 'separator' },
    { kind: 'item', id: 'download', label: 'Download source (tar.gz)' },
  ]

  return (
    <header className="ls-contextbar">
      <IconButton
        label="Open navigation menu"
        icon="menu"
        className="ls-contextbar__menu"
        onClick={onOpenMobileNav}
      />
      <nav aria-label="Breadcrumb" className="ls-breadcrumb">
        <span className="ls-breadcrumb__group">{group}</span>
        <span aria-hidden="true" style={{ color: 'var(--ls-text-disabled)' }}>
          /
        </span>
        <span style={{ color: 'var(--ls-text)' }}>{project}</span>
        <Badge variant={visibility === 'Public' ? 'success' : 'neutral'}>{visibility}</Badge>
      </nav>

      <div className="ls-contextbar__actions">
        <Dropdown
          menuLabel="Clone repository"
          trigger={({ onClick }) => (
            <Button size="sm" iconEnd="chevron-down" onClick={onClick}>
              Clone
            </Button>
          )}
          items={cloneItems}
        />
        <Button size="sm" iconStart="star" aria-label="Star this project. Current count 128.">
          Star · 128
        </Button>
        <IconButton label="Watch project" icon="eye" />
      </div>
    </header>
  )
}

export function RepoTabs({
  tabs,
  currentTab,
  onTab,
}: Pick<RepoContextNavProps, 'tabs' | 'currentTab' | 'onTab'>) {
  return (
    <div role="tablist" aria-label="Repository sections" className="ls-tabs__list" style={{ padding: `0 var(--ls-main-pad)` }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === currentTab}
          className="ls-tabs__tab"
          onClick={() => onTab(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <Badge>{tab.count}</Badge>}
        </button>
      ))}
    </div>
  )
}
