import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { announce } from '../../components/ui';

export interface CollectionNavOptions {
  ids: string[];
  /** 1 for list view; tiles per row for grid view (enables left/right movement). */
  columns: number;
  onOpen: (index: number) => void;
  onDelete?: (ids: string[]) => void;
  onRename?: (index: number) => void;
  onMenu?: (index: number) => void;
  /** Scroll the virtualized list so the index is rendered before focusing it. */
  scrollToIndex: (index: number) => void;
  containerRef: React.RefObject<HTMLElement | null>;
}

const isTouch = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Selection + roving focus for the file list/grid (WAI-ARIA grid pattern).
 * Selection is keyed by id so it survives re-sorting and background refreshes.
 */
export function useCollectionNav(o: CollectionNavOptions) {
  const { ids, columns } = o;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState(0);
  const anchor = useRef<number | null>(null);
  const count = ids.length;
  // Callbacks and refs from the caller change every render; read the latest through a ref so
  // the handlers below (and the object returned) only change when the data does.
  const latest = useRef(o);
  useLayoutEffect(() => {
    latest.current = o;
  });

  /** Brings the item into view (rendering it if virtualized away) and moves DOM focus to it. */
  const focusItem = useCallback((index: number) => {
    latest.current.scrollToIndex(index);
    requestAnimationFrame(() => {
      latest.current.containerRef.current
        ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        ?.focus({ preventScroll: true });
    });
  }, []);

  // The id of the item that has DOM focus (or holds it inside, e.g. its menu button).
  const focusedId = useRef<string | null>(null);

  // Drop selections for items that disappeared (deleted/moved elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(ids);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setFocus((f) => Math.min(f, Math.max(0, count - 1)));
  }, [ids, count]);

  // When the focused item itself goes away (Delete, "Move to trash" from its menu), focus would
  // silently drop to <body>; keep it in the list on the item that took its place.
  useLayoutEffect(() => {
    const id = focusedId.current;
    if (!id || ids.includes(id)) return;
    focusedId.current = null;
    const active = document.activeElement;
    if (count === 0 || (active && active !== document.body && active.isConnected)) return;
    const next = Math.min(focus, count - 1);
    setFocus(next);
    focusItem(next);
  }, [ids, count, focus, focusItem]);

  const moveTo = useCallback(
    (index: number, extend: boolean) => {
      const next = Math.max(0, Math.min(count - 1, index));
      setFocus(next);
      focusItem(next);
      if (extend) {
        // Shift+arrow without a prior anchor starts the range at the current item.
        anchor.current ??= focus;
        const from = anchor.current;
        const [a, b] = from < next ? [from, next] : [next, from];
        setSelected(new Set(ids.slice(a, b + 1)));
      } else {
        anchor.current = next;
      }
    },
    [count, focus, ids, focusItem],
  );

  const toggle = useCallback(
    (index: number) => {
      const id = ids[index];
      if (!id) return;
      anchor.current = index;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [ids],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(ids));
    announce(`${ids.length} items selected`);
  }, [ids]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only keys pressed on an item: the column headers' sort buttons need their own Enter and
      // Space.
      if (count === 0 || !(e.target as Element).closest('[data-index]')) return;
      const o = latest.current;
      const cols = Math.max(1, columns);
      const mod = e.metaKey || e.ctrlKey;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          return moveTo(focus + cols, e.shiftKey);
        case 'ArrowUp':
          e.preventDefault();
          return moveTo(focus - cols, e.shiftKey);
        case 'ArrowRight':
          if (cols > 1) {
            e.preventDefault();
            moveTo(focus + 1, e.shiftKey);
          }
          return;
        case 'ArrowLeft':
          if (cols > 1) {
            e.preventDefault();
            moveTo(focus - 1, e.shiftKey);
          }
          return;
        case 'Home':
          e.preventDefault();
          return moveTo(0, e.shiftKey);
        case 'End':
          e.preventDefault();
          return moveTo(count - 1, e.shiftKey);
        case 'PageDown':
          e.preventDefault();
          return moveTo(focus + cols * 10, e.shiftKey);
        case 'PageUp':
          e.preventDefault();
          return moveTo(focus - cols * 10, e.shiftKey);
        case ' ':
          e.preventDefault();
          return toggle(focus);
        case 'Enter':
          e.preventDefault();
          return o.onOpen(focus);
        case 'Escape':
          if (selected.size) {
            e.preventDefault();
            clear();
          }
          return;
        case 'Delete':
        case 'Backspace': {
          if (!o.onDelete) return;
          e.preventDefault();
          const target = selected.size ? [...selected] : [ids[focus]!];
          return o.onDelete(target);
        }
        case 'F2':
          e.preventDefault();
          return o.onRename?.(focus);
        case 'ContextMenu':
          e.preventDefault();
          return o.onMenu?.(focus);
        case 'F10':
          if (e.shiftKey) {
            e.preventDefault();
            o.onMenu?.(focus);
          }
          return;
        case 'a':
        case 'A':
          if (mod) {
            e.preventDefault();
            selectAll();
          }
          return;
      }
    },
    [count, columns, focus, ids, moveTo, selectAll, selected, toggle, clear],
  );

  const onItemClick = useCallback(
    (index: number, e: MouseEvent) => {
      setFocus(index);
      const id = ids[index];
      if (!id) return;
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
        setSelected(new Set(ids.slice(a, b + 1)));
        return;
      }
      if (e.metaKey || e.ctrlKey) return toggle(index);
      // Touch: a tap opens (like Files/Drive on phones) unless we're already selecting.
      if (isTouch()) {
        if (selected.size > 0) return toggle(index);
        return latest.current.onOpen(index);
      }
      anchor.current = index;
      setSelected(new Set([id]));
    },
    [ids, selected.size, toggle],
  );

  /** Put on each item: tracks which item holds focus (see the removal handling above). */
  const onItemFocus = useCallback(
    (index: number) => {
      setFocus(index);
      focusedId.current = ids[index] ?? null;
    },
    [ids],
  );

  /** Put on the container: focus leaving the list for elsewhere on the page. */
  const onContainerBlur = useCallback((e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to)) focusedId.current = null;
  }, []);

  return useMemo(
    () => ({
      selected,
      setSelected,
      focus,
      setFocus,
      focusItem,
      toggle,
      selectAll,
      clear,
      onKeyDown,
      onItemClick,
      onItemFocus,
      onContainerBlur,
    }),
    [
      selected,
      focus,
      focusItem,
      toggle,
      selectAll,
      clear,
      onKeyDown,
      onItemClick,
      onItemFocus,
      onContainerBlur,
    ],
  );
}
