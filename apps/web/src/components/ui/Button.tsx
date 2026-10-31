import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn.js'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-[#20120a] font-medium hover:bg-brand-soft disabled:hover:bg-brand disabled:opacity-45',
  ghost: 'text-muted hover:text-ink hover:bg-panel-3 disabled:opacity-40',
  outline:
    'border border-line text-ink hover:border-[#3a3431] hover:bg-panel-3 disabled:opacity-40',
  danger: 'text-bad hover:bg-[#2a1715] disabled:opacity-40',
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-[12px]',
  md: 'h-8.5 gap-2 rounded-lg px-3 text-[13px]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children?: ReactNode
}

export function Button({ variant = 'outline', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/60',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  )
}
