import { Tooltip as T } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

export const TooltipProvider = T.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Supplementary hint on hover/focus. Never the only place important information lives. */
export function Tooltip({ content, children, side = 'bottom' }: TooltipProps) {
  return (
    <T.Root delayDuration={400}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 animate-fade-in rounded-md bg-text px-2 py-1 text-xs text-bg shadow-pop"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
