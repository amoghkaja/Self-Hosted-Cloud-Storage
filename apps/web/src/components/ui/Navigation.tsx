import { ChevronRight } from 'lucide-react';
import { Tabs as T } from 'radix-ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
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
 * screens the trail scrolls horizontally instead of wrapping, showing its end, and the current
 * folder's name gets two lines.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const trail = useRef<HTMLOListElement>(null);
  const path = items.map((c) => c.key).join('/');
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again only when the path changes
  useLayoutEffect(() => {
    const el = trail.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);
  return (
    <nav aria-label="Folder path" className={cn('min-w-0', className)}>
      <ol
        ref={trail}
        className="flex items-center gap-0.5 overflow-x-auto text-sm whitespace-nowrap [scrollbar-width:none]"
      >
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            // Folders above keep their names (up to 12rem) and the trail scrolls; squeezing
            // every crumb left "My F… › Docum… › Ta… › 2…".
            <li
              key={c.key}
              className={cn('flex items-center gap-0.5', last ? 'min-w-24' : 'shrink-0')}
            >
              {i > 0 && <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />}
              {last || !c.to ? (
                <span
                  aria-current={last ? 'page' : undefined}
                  title={c.label}
                  className={cn(
                    'rounded-md px-1.5 py-1',
                    last
                      ? 'line-clamp-2 font-semibold whitespace-normal [overflow-wrap:anywhere]'
                      : 'max-w-[12rem] truncate text-muted',
                  )}
                >
                  {c.label}
                </span>
              ) : (
                <Link
                  to={c.to}
                  title={c.label}
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

// ── Glass indicator ─────────────────────────────────────────────────────────

/** Where each remembered indicator last was, so a row re-created by the next page still slides. */
const lastIndex = new Map<string, number>();

/**
 * The selected-segment highlight of a row of equal-width items (tab bar, segmented control): a
 * piece of glass that slides to the new item, stretching as it goes and settling with a slight
 * overshoot, like iOS 26. Sits behind the items in a `relative` container with a 4px (p-1) inset.
 * `memoryKey` lets a row that each page renders anew slide from where the last page left it.
 * Reduced Motion drops the movement (index.css).
 */
export function GlassIndicator({
  index,
  count,
  memoryKey,
  className,
}: {
  index: number;
  count: number;
  memoryKey?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(() => {
    const last = memoryKey === undefined ? undefined : lastIndex.get(memoryKey);
    return last !== undefined && last >= 0 ? last : index;
  });
  // Stretch only when the selection moves, not when the page first shows it.
  const start = useRef(shown);
  useEffect(() => {
    if (memoryKey !== undefined) lastIndex.set(memoryKey, index);
    // A frame at the old position first, so the move animates.
    const raf = requestAnimationFrame(() => setShown(index));
    return () => cancelAnimationFrame(raf);
  }, [index, memoryKey]);
  if (shown < 0) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-1 left-1 transition-transform duration-500 ease-[cubic-bezier(0.34,1.35,0.64,1)]"
      style={{
        width: `calc((100% - 0.5rem) / ${count})`,
        transform: `translateX(${shown * 100}%)`,
      }}
    >
      <span
        key={shown}
        className={cn(
          'block h-full rounded-full',
          shown !== start.current && 'animate-lens',
          className,
        )}
      />
    </span>
  );
}

// ── Section links ───────────────────────────────────────────────────────────

/**
 * Sibling pages of one phone tab (Files · Recent · Starred · Trash) as a segmented control.
 * Phones only: larger screens reach them from the sidebar.
 */
export function SectionLinks({
  label,
  items,
}: {
  label: string;
  items: { to: string; label: string }[];
}) {
  const { pathname } = useLocation();
  const active = items.findIndex((i) => i.to === pathname);
  return (
    <nav aria-label={label} className="mb-4 md:hidden">
      <ul className="relative flex rounded-full bg-surface-2 p-1">
        <GlassIndicator
          index={active}
          count={items.length}
          memoryKey={label}
          className="bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.6)]"
        />
        {items.map((i) => (
          <li key={i.to} className="relative flex-1">
            <NavLink
              to={i.to}
              end
              className={({ isActive }) =>
                cn(
                  'flex min-h-11 items-center justify-center rounded-full px-2 text-sm font-medium transition-colors active:scale-95',
                  isActive ? 'text-text' : 'text-muted',
                )
              }
            >
              {i.label}
            </NavLink>
          </li>
        ))}
      </ul>
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
            className="relative min-h-10 pointer-coarse:min-h-11 min-w-fit flex-1 rounded-t-md px-2 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent sm:flex-none sm:px-3"
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
