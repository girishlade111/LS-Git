import type { ReactNode } from 'react'
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

/** Dense data table. Always provide a caption or an aria-label for context. */
export function Table({
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { children: ReactNode }) {
  return (
    <div className="ls-table-wrap">
      <table className="ls-table" {...rest}>
        {children}
      </table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

export function TR(props: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} />
}

export function TH(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" {...props} />
}

export function TD(props: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} />
}
