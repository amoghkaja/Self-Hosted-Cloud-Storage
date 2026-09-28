import { Check } from 'lucide-react';
import { ContextMenu as CM, DropdownMenu as DM } from 'radix-ui';
import { Fragment, type ReactElement, type ReactNode, useRef } from 'react';
import { cn } from '../../lib/cn';
import { rememberInvoker } from './focusReturn';

/**
 * One action model rendered as either a dropdown (kebab button) or a right-click / long-press
 * context menu, so both stay in sync and keyboard users get the same actions.
 */
export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /**
   * Marks the item as one choice of a set (e.g. a sort order). Announced as a checked/unchecked
   * radio item and shows a check mark, instead of the icon.
   */
  checked?: boolean;
  onSelect: () => void;
  /** Visual separator before this item. */
  separatorBefore?: boolean;
}

const content =
  'z-50 min-w-[200px] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop animate-pop-in';
// Menus render in a portal, but React still bubbles their events up the component tree to
// whatever contains the trigger (a file row, the file grid). Stop them at the menu boundary so
// choosing an item doesn't also click/select the row or drive the grid's arrow-key navigation.
const isolate = {
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onContextMenu: (e: React.SyntheticEvent) => e.stopPropagation(),
};

const item =
  'flex h-9 pointer-coarse:h-11 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-2';

function ItemBody({ a }: { a: MenuAction }) {
  return (
    <>
      <span aria-hidden="true" className="flex w-4 justify-center text-muted [&>svg]:size-4">
        {a.checked === undefined ? a.icon : a.checked ? <Check /> : null}
      </span>
      <span className="flex-1">{a.label}</span>
      {a.shortcut && (
        <kbd className="font-sans text-xs text-muted pointer-coarse:hidden">{a.shortcut}</kbd>
      )}
    </>
  );
}

/** Props shared by both menus' items: radio semantics for `checked`, and focus bookkeeping. */
function itemProps(a: MenuAction, invoker: () => HTMLElement | null) {
  return {
    disabled: a.disabled,
    onSelect: () => {
      // If this opens a dialog, focus returns to what opened the menu when it closes.
      rememberInvoker(invoker());
      a.onSelect();
    },
    className: cn(item, a.tone === 'danger' && 'text-danger'),
    ...(a.checked === undefined
      ? {}
      : { role: 'menuitemradio' as const, 'aria-checked': a.checked }),
  };
}

export interface DropdownMenuProps {
  trigger: ReactElement;
  actions: MenuAction[];
  align?: 'start' | 'end';
  label?: string;
  /** Controlled open state (e.g. opened from a keyboard shortcut instead of the trigger). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Override where focus goes when the menu closes (default: back to the trigger). */
  onCloseAutoFocus?: (e: Event) => void;
}

export function DropdownMenu({
  trigger,
  actions,
  align = 'end',
  label,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: DropdownMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DM.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DM.Trigger asChild ref={triggerRef}>
        {trigger}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align={align}
          sideOffset={4}
          className={content}
          aria-label={label}
          onCloseAutoFocus={onCloseAutoFocus}
          {...isolate}
        >
          {actions.map((a) => (
            <Fragment key={a.id}>
              {a.separatorBefore && <DM.Separator className="my-1 h-px bg-border" />}
              <DM.Item {...itemProps(a, () => triggerRef.current)}>
                <ItemBody a={a} />
              </DM.Item>
            </Fragment>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface ContextMenuProps {
  children: ReactElement;
  actions: MenuAction[];
  onOpenChange?: (open: boolean) => void;
  /** Override where focus goes when the menu closes. */
  onCloseAutoFocus?: (e: Event) => void;
}

export function ContextMenu({
  children,
  actions,
  onOpenChange,
  onCloseAutoFocus,
}: ContextMenuProps) {
  const triggerRef = useRef<HTMLElement>(null);
  return (
    <CM.Root modal={false} onOpenChange={onOpenChange}>
      <CM.Trigger asChild ref={triggerRef}>
        {children}
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className={content} onCloseAutoFocus={onCloseAutoFocus} {...isolate}>
          {actions.map((a) => (
            <Fragment key={a.id}>
              {a.separatorBefore && <CM.Separator className="my-1 h-px bg-border" />}
              <CM.Item {...itemProps(a, () => triggerRef.current)}>
                <ItemBody a={a} />
              </CM.Item>
            </Fragment>
          ))}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
