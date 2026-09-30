import { Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,opacity,scale] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
  secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
  ghost: 'text-text hover:bg-surface-2',
  danger: 'bg-danger text-danger-fg hover:opacity-90',
};

// Touch screens get 44px-tall targets (Apple's minimum) whatever the size; mice keep compact ones.
const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 text-sm pointer-coarse:min-h-11',
  md: 'min-h-10 px-4 text-sm pointer-coarse:min-h-11',
  lg: 'min-h-12 px-5 text-base',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks further clicks. */
  loading?: boolean;
  icon?: ReactNode;
  /** Render the child element (e.g. a router Link) with button styling. */
  asChild?: boolean;
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md') {
  return cn(base, variants[variant], sizes[size]);
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  asChild,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root className={cn(buttonClass(variant, size), className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type}
      className={cn(buttonClass(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
}
