import { ContextMenu as CM, DropdownMenu as DM } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

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
  'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-2';

function ItemBody({ a }: { a: MenuAction }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted [&>svg]:size-4">
        {a.icon}
      </span>
      <span className="flex-1">{a.label}</span>
      {a.shortcut && <kbd className="font-sans text-xs text-muted">{a.shortcut}</kbd>}
    </>
  );
}

export interface DropdownMenuProps {
  trigger: ReactElement;
  actions: MenuAction[];
  align?: 'start' | 'end';
  label?: string;
}

export function DropdownMenu({ trigger, actions, align = 'end', label }: DropdownMenuProps) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          align={align}
          sideOffset={4}
          className={content}
          aria-label={label}
          {...isolate}
        >
          {actions.map((a) => (
            <div key={a.id}>
              {a.separatorBefore && <DM.Separator className="my-1 h-px bg-border" />}
              <DM.Item
                disabled={a.disabled}
                onSelect={a.onSelect}
                className={cn(item, a.tone === 'danger' && 'text-danger')}
              >
                <ItemBody a={a} />
              </DM.Item>
            </div>
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
}

export function ContextMenu({ children, actions, onOpenChange }: ContextMenuProps) {
  return (
    <CM.Root modal={false} onOpenChange={onOpenChange}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={content} {...isolate}>
          {actions.map((a) => (
            <div key={a.id}>
              {a.separatorBefore && <CM.Separator className="my-1 h-px bg-border" />}
              <CM.Item
                disabled={a.disabled}
                onSelect={a.onSelect}
                className={cn(item, a.tone === 'danger' && 'text-danger')}
              >
                <ItemBody a={a} />
              </CM.Item>
            </div>
          ))}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
