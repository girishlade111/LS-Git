import type { ReactElement, SVGProps } from 'react'

export type IconName =
  | 'search' | 'menu' | 'close' | 'check' | 'chevron-down' | 'chevron-right'
  | 'chevron-left' | 'plus' | 'folder' | 'file' | 'star' | 'eye'
  | 'branch' | 'issue' | 'merge' | 'settings' | 'code' | 'tag'
  | 'bell' | 'clock' | 'warning' | 'external' | 'copy' | 'trash' | 'more'

const paths: Record<IconName, ReactElement> = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4.5 12.5 10 18 19.5 7" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  file: <><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" /><path d="M13 3v6h6" /></>,
  star: <path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7Z" />,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  branch: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 7.2v9.6M18 10.2c0 3.3-3 4.3-6 4.6-2 .2-4 .6-4 2.2" /></>,
  issue: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.5" /></>,
  merge: <><circle cx="6.5" cy="5" r="2.2" /><circle cx="6.5" cy="19" r="2.2" /><circle cx="17.5" cy="12" r="2.2" /><path d="M6.5 7.2v9.6M6.5 8.5C6.5 12 10 12 15.3 12" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.14-1.4l2.1-1.63-2-3.46-2.48 1a7 7 0 0 0-2.42-1.4L13.7 2.5h-3.4l-.36 2.61a7 7 0 0 0-2.42 1.4l-2.48-1-2 3.46 2.1 1.63A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2.1 1.63 2 3.46 2.48-1a7 7 0 0 0 2.42 1.4l.36 2.61h3.4l.36-2.61a7 7 0 0 0 2.42-1.4l2.48 1 2-3.46-2.1-1.63c.09-.46.14-.92.14-1.4Z" /></>,
  code: <path d="m8 8-4.5 4L8 16M16 8l4.5 4L16 16M13 5l-2.5 14" />,
  tag: <><path d="M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8L3 11Z" /><circle cx="8" cy="8" r="1.4" /></>,
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9Z" /><path d="M10 19.7a2.2 2.2 0 0 0 4 0" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></>,
  warning: <><path d="M12 3 1.8 20.2h20.4L12 3Z" /><path d="M12 9.5v5M12 17.6v.2" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M19 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5.5" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
