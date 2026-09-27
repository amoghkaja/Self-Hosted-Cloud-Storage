import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** Required: becomes the accessible name and the tooltip text. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
  /** Hide the tooltip (e.g. when used as a Radix trigger that has its own affordance). */
  noTooltip?: boolean;
}

export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  noTooltip,
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-8' : 'size-10',
        variant === 'ghost'
          ? 'hover:bg-surface-2'
          : 'border border-border bg-surface hover:bg-surface-2',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="[&>svg]:size-[18px]">
        {icon as ReactNode}
      </span>
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
