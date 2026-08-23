# LSGit — Design System

Status: **IMPLEMENTED** (`web/src/design-system/`, `web/src/styles/tokens.css`).
This document is the contract for the LSGit visual language. Feature code must not
introduce values outside these tokens.

---

## 1. Visual language (fixed — do not redesign)

Flat, dark, developer-tool density. No shadows, no gradients, no glass, no pure
black/white, no neon, no oversized typography.

### Color tokens

| Token | Value | Use |
|---|---|---|
| `--ls-bg` | `#0d0d0d` | App background, inputs |
| `--ls-panel` | `#161616` | Sidebar, cards, menus, dialogs |
| `--ls-surface-1` | `#1c1c1c` | Hover rows, secondary buttons, table headers |
| `--ls-surface-2` | `#242424` | Chips, toggle track, skeleton |
| `--ls-border` | `#2a2a2a` | All 1px borders |
| `--ls-text` | `#e8e8e8` | Primary text |
| `--ls-text-secondary` | `#8a8a8a` | Descriptions, metadata (5.3:1 on panel) |
| `--ls-text-disabled` | `#5c5c5c` | Disabled controls only (exempt from contrast) |
| `--ls-accent` | `#e07856` | Primary actions, selection, focus ring (6.3:1 on bg) |
| `--ls-success` | `#3ecf5e` | Success states |
| `--ls-danger` | `#e5484d` | Destructive/error states |

Alpha derivatives (hovers, tints) live in tokens.css: `--ls-hover`,
`--ls-hover-strong`, `--ls-active`, `--ls-on-accent-hover/-active`,
`--ls-tint-success/danger/accent`, `--ls-scrim`. Solid buttons with colored
backgrounds use dark text (`--ls-bg`) for ≥4.5:1 contrast.

### Typography

System UI stack only (`--ls-font-ui`). Code surfaces use the system **mono** stack
(`--ls-font-mono`) — required for a Git host; both are "system" stacks.

| Token | Spec |
|---|---|
| `--ls-fs-body` | 13px / 1.5 (default text) |
| `--ls-fs-h1` | 22px / 600 |
| `--ls-fs-label` | 12px / 400–500 (section labels, badges, table headers) |
| `--ls-fs-row` | 13.5px / 500 (row titles, dialog titles) |
| `--ls-fs-desc` | 12.5px (descriptions) |
| `--ls-fs-table` | 12px / 500 |

### Layout & shape

- Sidebar `--ls-sidebar-w`: 260px · Main padding `--ls-main-pad`: clamp(32px→48px)
- Card radius `--ls-radius`: 8px; controls 5px; borders always 1px
- Focus ring: 2-step box-shadow ring in accent (`--ls-focus-ring`), never removed

## 2. Component inventory (`web/src/design-system/`)

Button · IconButton · Input · Textarea · Select · Combobox · Checkbox · Toggle ·
Tabs · Dropdown · Dialog · Drawer · Tooltip · Toast(+Provider/useToast) · Badge ·
Avatar · Table(+THead/TBody/TR/TH/TD) · Pagination · EmptyState · Skeleton ·
FileTree · CodeBlock · DiffViewer(+parseUnifiedDiff) · ActivityItem ·
StatusIndicator · Icon(25 inline SVGs).

All primitives are token-driven, `forwardRef` where relevant, and typed.

## 3. Accessibility contract

- **Keyboard**: Tabs/Dropdown/FileTree implement ARIA patterns with roving focus and
  arrow keys; Dialog/Drawer trap Tab and restore focus on close; Escape closes all
  overlays; Combobox implements ARIA 1.2 combobox (`aria-activedescendant`).
- **Names**: every control has an accessible name (label, aria-label, or required
  `label` prop on IconButton); Icon is `aria-hidden`.
- **Live regions**: Toast renders a polite live region; validation errors use
  `role="alert"` + `aria-invalid`; DiffViewer announces added/removed lines.
- **Visibility**: `:focus-visible` ring on all interactive elements;
  `prefers-reduced-motion` collapses animations; Skeleton is `aria-hidden`.

## 4. Application shell (`web/src/shell/`)

`AppShell` = dense 260px sidebar (Workspace/Work/Instance sections + user menu) +
sticky repository context bar (breadcrumb, visibility badge, Clone dropdown,
Star/Watch) + repository tab navigation + fluid main content. Below 900px the sidebar
becomes an off-canvas Drawer driven by the context-bar menu button. Settings uses a
secondary in-content nav column (`SettingsNav`). Demo views: Overview (file tree +
code + branches table + activity), Design System playground, Settings panels.

## 5. Rules for feature work

1. Never hard-code colors/sizes/radii outside `tokens.css`.
2. New components must compose existing primitives before adding new ones.
3. Any new interactive pattern ships with keyboard + screen-reader tests.
4. Statuses map to `StatusKind`; semantic color only via success/danger/accent
   variants — no ad-hoc hues.
