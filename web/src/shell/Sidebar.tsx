import { Avatar } from '../design-system/Avatar'
import { Badge } from '../design-system/Badge'
import { Icon, type IconName } from '../design-system/Icon'
import { IconButton } from '../design-system/IconButton'
import { Dropdown } from '../design-system/Dropdown'
import { useAuth } from '../auth/context'
import { useHashRoute } from '../auth/context'

export interface SidebarProps {
  current: string
  onNavigate: (id: string) => void
  open: boolean
  onClose: () => void
}

interface NavEntry {
  id: string
  label: string
  icon: IconName
  badge?: number
}

const sections: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: 'Workspace',
    items: [
      { id: 'overview', label: 'Projects', icon: 'code' },
      { id: 'groups', label: 'Groups', icon: 'folder' },
    ],
  },
  {
    label: 'Work',
    items: [
      { id: 'issues', label: 'Issues', icon: 'issue', badge: 3 },
      { id: 'mrs', label: 'Merge requests', icon: 'merge' },
    ],
  },
]

/**
 * Global sidebar. Renders as a fixed off-canvas panel below 900px;
 * the Drawer-like behavior is driven by `open` from AppShell.
 */
export function Sidebar({ current, onNavigate, open }: SidebarProps) {
  const { user, signOut } = useAuth()
  const { navigate } = useHashRoute()

  return (
    <aside className="ls-sidebar" data-open={open} aria-label="Primary">
      <div className="ls-sidebar__brand">
        <span className="ls-sidebar__brand-mark" aria-hidden="true">
          LS
        </span>
        LSGit
      </div>

      <button type="button" className="ls-searchbtn" aria-label="Search LSGit">
        <Icon name="search" size={14} />
        Search…
        <kbd>Ctrl K</kbd>
      </button>

      {sections.map((section) => (
        <nav key={section.label} className="ls-sidebar__section" aria-label={section.label}>
          <div className="ls-sidebar__label">{section.label}</div>
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ls-navitem"
              aria-current={current === item.id ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
              {item.badge !== undefined && <Badge>{item.badge}</Badge>}
            </button>
          ))}
        </nav>
      ))}

      <nav className="ls-sidebar__section" aria-label="Instance">
        <div className="ls-sidebar__label">Instance</div>
        <button type="button" className="ls-navitem" onClick={() => onNavigate('design-system')}>
          <Icon name="eye" size={15} />
          Design system
        </button>
        <button type="button" className="ls-navitem" onClick={() => onNavigate('settings')}>
          <Icon name="settings" size={15} />
          Settings
        </button>
      </nav>

      <div className="ls-sidebar__spacer" />

      <div className="ls-sidebar__user">
        <Avatar name={user?.name ?? user?.username ?? '?'} size="sm" />
        <span style={{ minWidth: 0 }}>
          <div className="ls-sidebar__user-name">{user?.name ?? user?.username ?? '…'}</div>
          <div className="ls-sidebar__user-handle">@{user?.username ?? ''}</div>
        </span>
        <Dropdown
          menuLabel="Account menu"
          align="right"
          trigger={({ onClick, 'aria-expanded': expanded }) => (
            <IconButton label="Open account menu" icon="more" active={expanded} onClick={onClick} />
          )}
          items={[
            { kind: 'item', id: 'account', label: 'Account settings' },
            { kind: 'item', id: 'profile', label: 'Public profile' },
            { kind: 'separator' },
            { kind: 'item', id: 'signout', label: 'Sign out' },
          ]}
          onSelect={(id) => {
            if (id === 'signout') void signOut().then(() => navigate('/login'))
            else if (id === 'account') navigate('/account')
          }}
        />
      </div>
    </aside>
  )
}
