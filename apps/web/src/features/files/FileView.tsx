// Accessibility note: this is a WAI-ARIA grid built from divs (role=grid/row/gridcell) because
// virtualized, absolutely positioned rows cannot be a <table>. Focus lives on rows/tiles via a
// roving tabindex (useCollectionNav). Biome's table/focusability suggestions are disabled for
// this file only (see biome.json overrides); keyboard + axe behaviour is covered by tests.
import { formatBytes, type SortDir, type SortKey } from '@familycloud/shared';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Check, CircleCheck, EllipsisVertical } from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContextMenu, DropdownMenu, type MenuAction, Skeleton, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/format';
import { FileIcon, type NodeVisual } from './FileIcon';
import { useCollectionNav } from './useCollectionNav';

export interface ViewItem extends NodeVisual {
  id: string;
  size: number;
  updatedAt: string;
}

export interface FileViewProps<T extends ViewItem> {
  items: T[];
  view: 'list' | 'grid';
  label: string;
  onOpen: (item: T) => void;
  actionsFor: (item: T) => MenuAction[];
  thumbSrc?: (item: T) => string | undefined;
  onDelete?: (ids: string[]) => void;
  onRename?: (item: T) => void;
  onSelectionChange?: (ids: ReadonlySet<string>) => void;
  /** Replaces the selection from outside (e.g. "clear" in the selection bar). */
  selectionResetKey?: number;
  sort?: { key: SortKey; dir: SortDir; onChange: (key: SortKey, dir: SortDir) => void };
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Extra line under the name (e.g. "Shared by Mom"). */
  subtitle?: (item: T) => ReactNode;
  /** Small marker after the name (e.g. a star). */
  badge?: (item: T) => ReactNode;
  /**
   * Height of sticky page chrome (app header, selection toolbar) covering the top of the
   * window, so keyboard navigation doesn't scroll the focused row underneath it.
   */
  scrollPaddingTop?: number;
}

const LIST_ROW = 56;
const GRID_GAP = 12;
const MIN_TILE = 150;

function useColumns(ref: React.RefObject<HTMLDivElement | null>, view: 'list' | 'grid') {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  if (view === 'list' || width === 0) return { columns: 1, tile: 0 };
  const columns = Math.max(2, Math.floor((width + GRID_GAP) / (MIN_TILE + GRID_GAP)));
  return { columns, tile: (width - GRID_GAP * (columns - 1)) / columns };
}

function SortHeader({
  label,
  k,
  sort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: FileViewProps<ViewItem>['sort'];
  className?: string;
}) {
  const active = sort?.key === k;
  const nextDir: SortDir = active && sort?.dir === 'asc' ? 'desc' : 'asc';
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      {sort ? (
        <button
          type="button"
          onClick={() => sort.onChange(k, nextDir)}
          className="inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-muted hover:text-text"
        >
          {label}
          {active &&
            (sort.dir === 'asc' ? (
              <ArrowUp size={12} aria-hidden />
            ) : (
              <ArrowDown size={12} aria-hidden />
            ))}
        </button>
      ) : (
        <span className="px-1 text-xs font-medium text-muted">{label}</span>
      )}
    </div>
  );
}

/**
 * The list/grid of files used by folders, search, shared-with-me and public links.
 * Virtualized against the window scroll (smooth with 10k+ items, natural on phones),
 * keyboard-navigable, multi-select, with the same actions via kebab menu and right-click.
 */
function FileViewInner<T extends ViewItem>(p: FileViewProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const { columns, tile } = useColumns(containerRef, p.view);
  const rowCount = Math.ceil(p.items.length / columns);
  const rowHeight = p.view === 'list' ? LIST_ROW : tile + 52 + GRID_GAP;

  // Where the rows start on the page (below the column headers). Content above can change
  // height after mount (a banner wraps, the header row wraps), so re-check after every render;
  // it only re-renders when the offset actually moved.
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    setMargin((m) => (Math.abs(m - top) < 1 ? m : top));
  });

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => rowHeight,
    overscan: 6,
    scrollMargin: margin,
    scrollPaddingStart: p.scrollPaddingTop ?? 0,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row height changes (view/width switch)
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const ids = useMemo(() => p.items.map((i) => i.id), [p.items]);
  // The item whose actions menu is open from the keyboard (Shift+F10 / the menu key).
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const nav = useCollectionNav({
    ids,
    columns,
    containerRef,
    onOpen: (i) => p.items[i] && p.onOpen(p.items[i]),
    onDelete: p.onDelete,
    onRename: (i) => p.items[i] && p.onRename?.(p.items[i]),
    onMenu: setMenuIndex,
    scrollToIndex: (i) => virtualizer.scrollToIndex(Math.floor(i / columns), { align: 'auto' }),
  });
  // A menu closing puts focus back on its item, unless the user already moved it elsewhere
  // (clicked another control) or the chosen action opened a dialog. If the item itself went
  // away (moved to trash), its successor at the same position gets focus instead.
  const restoreFocusTo = (index: number) => (e: Event) => {
    e.preventDefault();
    const active = document.activeElement;
    if (!active || active === document.body) nav.focusItem(Math.min(index, ids.length - 1));
  };

  const { onSelectionChange } = p;
  useEffect(() => onSelectionChange?.(nav.selected), [nav.selected, onSelectionChange]);
  const resetKey = useRef(p.selectionResetKey);
  useEffect(() => {
    if (resetKey.current !== p.selectionResetKey) {
      resetKey.current = p.selectionResetKey;
      nav.clear();
    }
  }, [p.selectionResetKey, nav]);

  // Infinite scroll: ask for the next page when the last rendered row nears the end.
  const virtualRows = virtualizer.getVirtualItems();
  const lastRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  const { hasMore, loadingMore, onLoadMore } = p;
  useEffect(() => {
    if (hasMore && !loadingMore && lastRow >= rowCount - 8) onLoadMore?.();
  }, [lastRow, rowCount, hasMore, loadingMore, onLoadMore]);

  const selectionMode = nav.selected.size > 0;

  const renderItem = (item: T, index: number) => {
    const selected = nav.selected.has(item.id);
    const focused = nav.focus === index;
    const own = p.actionsFor(item);
    // Selecting from the menu is the discoverable way in on touch screens, where the check
    // circle is hidden and a tap opens the item.
    const actions: MenuAction[] =
      p.onSelectionChange && own.length > 0
        ? [
            ...own,
            {
              id: 'select',
              label: selected ? 'Deselect' : 'Select',
              icon: <CircleCheck />,
              separatorBefore: true,
              onSelect: () => nav.toggle(index),
            },
          ]
        : own;
    const common = {
      'data-index': index,
      tabIndex: focused ? 0 : -1,
      'aria-selected': selected,
      onFocus: () => nav.onItemFocus(index),
      onClick: (e: React.MouseEvent) => nav.onItemClick(index, e),
      onDoubleClick: () => p.onOpen(item),
    };
    const check = (
      <button
        type="button"
        tabIndex={-1}
        aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
        onClick={(e) => {
          e.stopPropagation();
          nav.toggle(index);
        }}
        className={cn(
          // A 24px circle with a 44px touch area around it.
          "relative flex size-6 shrink-0 items-center justify-center rounded-full border transition-opacity after:absolute after:-inset-2.5 after:content-['']",
          selected
            ? 'border-accent bg-accent text-accent-fg opacity-100'
            : 'border-border-strong bg-surface text-transparent',
          // On touch screens it only appears once selecting (via the menu's "Select"), so rows
          // don't carry an empty gutter.
          !selected &&
            !selectionMode &&
            'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:hidden',
        )}
      >
        <Check size={14} aria-hidden />
      </button>
    );
    // Nothing to offer (e.g. a view-only public link): no empty menus.
    const kebab =
      actions.length === 0 ? (
        <span className="size-9 shrink-0 pointer-coarse:size-11" />
      ) : (
        <DropdownMenu
          label={`Actions for ${item.name}`}
          actions={actions}
          open={menuIndex === index}
          onOpenChange={(open) => setMenuIndex(open ? index : null)}
          onCloseAutoFocus={restoreFocusTo(index)}
          trigger={
            <button
              type="button"
              tabIndex={-1}
              aria-label={`More actions for ${item.name}`}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-text pointer-coarse:size-11"
            >
              <EllipsisVertical size={18} aria-hidden />
            </button>
          }
        />
      );
    const withContextMenu = (el: React.ReactElement) =>
      actions.length === 0 ? (
        el
      ) : (
        <ContextMenu actions={actions} onCloseAutoFocus={restoreFocusTo(index)}>
          {el}
        </ContextMenu>
      );

    if (p.view === 'list') {
      return withContextMenu(
        <div
          role="row"
          aria-rowindex={index + 2}
          {...common}
          className={cn(
            'group grid h-14 cursor-default grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-2 outline-none select-none [-webkit-touch-callout:none] sm:grid-cols-[auto_1fr_8rem_6rem_auto]',
            selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
            'focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <div role="gridcell" className="flex items-center gap-2">
            {check}
            <FileIcon node={item} thumbSrc={p.thumbSrc?.(item)} />
          </div>
          <div role="gridcell" className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium" title={item.name}>
              <span className="truncate">{item.name}</span>
              {p.badge?.(item)}
            </p>
            <p className="truncate text-xs text-muted sm:hidden">
              {item.type === 'file' ? `${formatBytes(item.size)} · ` : ''}
              {formatRelative(item.updatedAt)}
            </p>
            {p.subtitle && (
              <p className="hidden truncate text-xs text-muted sm:block">{p.subtitle(item)}</p>
            )}
          </div>
          <div role="gridcell" className="hidden text-sm text-muted sm:block">
            {formatRelative(item.updatedAt)}
          </div>
          <div
            role="gridcell"
            className="hidden text-right text-sm text-muted tabular-nums sm:block"
          >
            {item.type === 'file' ? formatBytes(item.size) : '—'}
          </div>
          <div role="gridcell">{kebab}</div>
        </div>,
      );
    }
    return withContextMenu(
      <div
        role="gridcell"
        {...common}
        className={cn(
          'group relative flex cursor-default flex-col overflow-hidden rounded-xl border outline-none select-none [-webkit-touch-callout:none]',
          selected
            ? 'border-accent ring-2 ring-accent'
            : 'border-border hover:border-border-strong',
          'focus-visible:ring-2 focus-visible:ring-accent',
        )}
        style={{ width: tile }}
      >
        <div className="relative bg-surface-2" style={{ height: tile }}>
          <FileIcon node={item} thumbSrc={p.thumbSrc?.(item)} size="lg" />
          <div className="absolute top-2 left-2">{check}</div>
        </div>
        <div className="flex h-[52px] items-center gap-1 bg-surface pr-1 pl-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium" title={item.name}>
              <span className="truncate">{item.name}</span>
              {p.badge?.(item)}
            </p>
            <p className="truncate text-xs text-muted">
              {item.type === 'file' ? formatBytes(item.size) : formatRelative(item.updatedAt)}
            </p>
          </div>
          {kebab}
        </div>
      </div>,
    );
  };

  return (
    <div
      ref={containerRef}
      role="grid"
      aria-label={p.label}
      aria-multiselectable="true"
      aria-rowcount={p.view === 'list' ? p.items.length + 1 : rowCount}
      onKeyDown={nav.onKeyDown}
      onBlur={nav.onContainerBlur}
      // Dialogs opened from an item return focus here if that item is gone by the time they close.
      data-focus-fallback=""
      className="relative"
    >
      {p.view === 'list' && (
        <div
          role="row"
          aria-rowindex={1}
          // Phones sort with the toolbar button; the header row stays for screen readers only.
          className="grid h-9 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border px-2 max-sm:sr-only sm:grid-cols-[auto_1fr_8rem_6rem_auto]"
        >
          <div
            role="columnheader"
            className={cn('w-[68px]', !selectionMode && 'pointer-coarse:w-9')}
          >
            <span className="sr-only">Type</span>
          </div>
          <SortHeader label="Name" k="name" sort={p.sort as FileViewProps<ViewItem>['sort']} />
          <SortHeader
            label="Modified"
            k="updated"
            sort={p.sort as FileViewProps<ViewItem>['sort']}
            className="hidden sm:block"
          />
          <SortHeader
            label="Size"
            k="size"
            sort={p.sort as FileViewProps<ViewItem>['sort']}
            className="hidden text-right sm:block"
          />
          <div role="columnheader" className="w-9 pointer-coarse:w-11">
            <span className="sr-only">Actions</span>
          </div>
        </div>
      )}
      <div ref={rowsRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualRows.map((row) => {
          const start = row.index * columns;
          const rowItems = p.items.slice(start, start + columns);
          return (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-rowindex is only set together with role="row" (grid view)
            <div
              key={row.key}
              role={p.view === 'grid' ? 'row' : undefined}
              aria-rowindex={p.view === 'grid' ? row.index + 1 : undefined}
              className={p.view === 'grid' ? 'flex' : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                gap: p.view === 'grid' ? GRID_GAP : undefined,
                paddingTop: p.view === 'grid' ? GRID_GAP : undefined,
              }}
            >
              {rowItems.map((item, i) => (
                <Fragment key={item.id}>{renderItem(item, start + i)}</Fragment>
              ))}
            </div>
          );
        })}
      </div>
      {p.loadingMore && (
        <div className="flex justify-center py-4 text-muted">
          <Spinner label="Loading more" />
        </div>
      )}
    </div>
  );
}

export const FileView = FileViewInner as <T extends ViewItem>(p: FileViewProps<T>) => ReactNode;

export function FileViewSkeleton({ view }: { view: 'list' | 'grid' }) {
  if (view === 'grid') {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 pt-3">
        {/* Static placeholders never reorder, so index keys are safe. */}
        {Array.from({ length: 12 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
          <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 pt-9">
      {Array.from({ length: 8 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <div key={i} className="flex h-14 items-center gap-3 px-2">
          <Skeleton className="size-9" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
        </div>
      ))}
    </div>
  );
}
