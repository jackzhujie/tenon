import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline'
}

// shadcn/ui 风格：className 合并 + {...props} 透传（这条透传是 callsite 能落到 DOM 的前提）
export function Button({ variant = 'default', className, ...props }: Props) {
  return <button className={`btn btn-${variant} ${className ?? ''}`} {...props} />
}
