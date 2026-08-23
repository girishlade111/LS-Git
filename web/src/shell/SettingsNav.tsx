import { Icon } from '../design-system/Icon'

export interface SettingsNavProps {
  items: Array<{ id: string; label: string }>
  current: string
  onSelect: (id: string) => void
}

/** Secondary settings navigation rendered inside main content (GitLab-style sub-nav). */
export function SettingsNav({ items, current, onSelect }: SettingsNavProps) {
  return (
    <nav className="ls-settings__nav" aria-label="Settings sections">
      <div className="ls-sidebar__label">Settings</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ls-navitem"
          aria-current={item.id === current ? 'true' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <Icon name="chevron-right" size={13} />
          {item.label}
        </button>
      ))}
    </nav>
  )
}
