import { ChevronRight } from 'lucide-react';
import { Tabs as T } from 'radix-ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';

// ── Breadcrumbs ─────────────────────────────────────────────────────────────

export interface Crumb {
  key: string;
  label: string;
  /** Omit for the current page. */
  to?: string;
}

/**
 * Path navigation. The last crumb is the current location (aria-current="page"); on narrow
 * screens the trail scrolls horizontally instead of wrapping.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Folder path" className={cn('min-w-0', className)}>
      <ol className="flex items-center gap-0.5 overflow-x-auto text-sm whitespace-nowrap [scrollbar-width:none]">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={c.key} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />}
              {last || !c.to ? (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={cn(
                    'truncate rounded-md px-1.5 py-1',
                    last ? 'font-semibold' : 'text-muted',
                  )}
                >
                  {c.label}
                </span>
              ) : (
                <Link
                  to={c.to}
                  className="max-w-[12rem] truncate rounded-md px-1.5 py-1 pointer-coarse:py-3 text-muted hover:bg-surface-2 hover:text-text"
                >
                  {c.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * Arrow keys move between tabs (roving focus), as per the WAI-ARIA tabs pattern. On phones the
 * tabs share the width, and the strip only scrolls sideways if they truly don't fit (with the
 * active one kept in view). `sticky` pins the strip under the app header while the page scrolls.
 */
export function Tabs({
  items,
  value,
  onValueChange,
  label,
  sticky = false,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (v: string) => void;
  label: string;
  sticky?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the active tab changes
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[data-state="active"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <T.Root value={value} onValueChange={onValueChange} className="flex flex-col gap-5">
      <T.List
        ref={list}
        aria-label={label}
        className={cn(
          'flex overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:none]',
          sticky && 'sticky top-(--header-h,0px) z-20 -mx-3 bg-bg px-3 md:mx-0 md:px-0',
        )}
      >
        {items.map((t) => (
          <T.Trigger
            key={t.value}
            value={t.value}
            className="relative h-10 pointer-coarse:h-11 min-w-fit flex-1 rounded-t-md px-2 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent sm:flex-none sm:px-3"
          >
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {items.map((t) => (
        <T.Content key={t.value} value={t.value} className="outline-none">
          {t.content}
        </T.Content>
      ))}
    </T.Root>
  );
}
