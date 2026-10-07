# UI components

The web app is built from a small set of accessible primitives in [`apps/web/src/components/ui`](../apps/web/src/components/ui). Features compose them; pages compose features.

## Architecture

```
routes (app/router.tsx)        which page for which URL; code-split admin, settings, public links
   └─ features/*               domain UI: files, uploads, sharing, admin, settings, auth, public
        ├─ api/queries.ts      server state (TanStack Query) + query keys
        ├─ api/upload-manager  upload queue living outside React
        └─ components/ui       primitives: no app knowledge, no data fetching
```

Rules that keep this healthy:

- **`components/ui` never imports from `features/` or `api/`.** Primitives take data through props, so they're reusable and testable in isolation.
- **Server state lives in TanStack Query**, not in component state. Query keys are defined once in `qk` (`api/queries.ts`); mutations invalidate precisely the folders they touched.
- **Fast-changing, app-wide state lives outside React** (upload queue, toasts, live announcements), read with `useSyncExternalStore`, so updates don't re-render the tree.
- **Design tokens are CSS variables** (`styles/index.css`) exposed as Tailwind colours (`bg-surface`, `text-muted`, `border-border`, `bg-accent` …). Light and dark themes switch by redefining the variables; components never hard-code colours.

## Conventions

| Convention | Why |
| --- | --- |
| Props extend the native element's props (`ComponentProps<'button'>`) and spread the rest | Every native attribute and `ref` (React 19 passes it as a prop) just works |
| `variant` and `size` props instead of style overrides | One place defines each look |
| `className` is for **layout** (margin, width, grid placement) | Avoids fighting variant styles |
| `asChild` (Radix Slot) renders a child element with the component's styling | E.g. a router `<Link>` that looks like a button |
| Icon-only controls **require** a `label` | It becomes the accessible name and the tooltip |
| Fields take `label`, `hint` and `error` and wire the ARIA ids themselves | Screen readers get the right description every time |
| Async actions show `loading` and block double-submits | Consistent feedback, no duplicate requests |

## Primitives

### Button / IconButton

```tsx
<Button variant="primary" icon={<Upload size={16} />} loading={saving} onClick={save}>
  Upload
</Button>

<Button asChild variant="secondary">
  <Link to="/files">Go to My Files</Link>
</Button>

<IconButton label="Move to trash" icon={<Trash2 />} onClick={trash} />
```

| Prop | Type | Default |
| --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | `'secondary'` |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` |
| `loading` | `boolean`: spinner, `aria-busy`, disabled | `false` |
| `icon` | `ReactNode` | |
| `asChild` | `boolean` | `false` |

### TextField / PasswordField / SelectField / SwitchField / Checkbox

```tsx
<TextField label="Folder name" value={name} onChange={(e) => setName(e.target.value)}
  error={problem} hint="Up to 255 characters" autoFocus />
<PasswordField label="Password" autoComplete="current-password" />
<SelectField label="Access" value={perm} onChange={(e) => setPerm(e.target.value)}>
  <option value="view">Can view</option>
  <option value="edit">Can edit</option>
</SelectField>
<SwitchField label="Allow downloads" description="Turn off to allow viewing only."
  checked={allow} onCheckedChange={setAllow} />
```

`error` sets `aria-invalid`, renders a `role="alert"` message and points `aria-describedby` at it (otherwise at the `hint`). `hideLabel` keeps the label for screen readers only. `SelectField` is a native `<select>`, which gives the best mobile and assistive-tech behaviour for free.

### Dialog / ConfirmDialog

```tsx
<Dialog open={open} onOpenChange={setOpen} title="New folder" size="sm"
  footer={<><Button onClick={() => setOpen(false)}>Cancel</Button>
           <Button variant="primary" type="submit" form="new-folder">Create</Button></>}>
  <form id="new-folder" onSubmit={create}>…</form>
</Dialog>

<ConfirmDialog open={!!target} onOpenChange={() => setTarget(null)} tone="danger"
  title="Delete forever?" description="This can't be undone." confirmLabel="Delete forever"
  onConfirm={() => purge.mutateAsync(target.id)} />
```

- Focus is trapped inside, Escape closes, and the rest of the page is inert (Radix).
- **Focus returns to whatever opened the dialog**, even when it was opened from a menu or keyboard shortcut rather than a trigger button (`useReturnFocus`).
- The dialog becomes a bottom sheet on phones.
- `ConfirmDialog` uses `role="alertdialog"`. `onConfirm` may return a promise: the button shows progress, and the dialog stays open if it rejects so the user can retry.

### DropdownMenu / ContextMenu

Both take the same `MenuAction[]`, so the kebab menu and the right-click / long-press menu never drift apart:

```tsx
const actions: MenuAction[] = [
  { id: 'open', label: 'Open', icon: <FolderOpen />, shortcut: 'Enter', onSelect: open },
  { id: 'trash', label: 'Move to trash', icon: <Trash2 />, tone: 'danger', separatorBefore: true, onSelect: trash },
];
<DropdownMenu label="Actions" actions={actions} trigger={<IconButton label="More" icon={<EllipsisVertical />} noTooltip />} />
<ContextMenu actions={actions}><div>…row…</div></ContextMenu>
```

Menus stop click and key events at their boundary. React bubbles events from portals up the component tree, which would otherwise select the row underneath or drive the list's arrow-key navigation.

### Feedback: Progress, UsageBar, Skeleton, Spinner, Badge, Avatar, EmptyState, ErrorState, QueryState

`QueryState` is the standard way to render a query. It handles every state:

```tsx
<QueryState
  query={trash}
  loading={<Skeleton className="h-40" />}               // shaped like the final layout
  isEmpty={(d) => d.items.length === 0}
  empty={<EmptyState icon={<Trash2 />} title="Trash is empty" />}
>
  {(d) => <TrashList items={d.items} />}
</QueryState>
```

- **Loading:** `aria-busy` plus a screen-reader "Loading…".
- **Error:** `ErrorState` with the server's message and a **Try again** button.
- **Empty and data:** rendered as given.

`UsageBar` turns amber at 80% and red at 95% or over quota, and shows "no limit" instead of an empty bar for unlimited accounts.

### Toasts and announcements

```tsx
toast.success('Moved “notes.txt” to trash', { action: { label: 'Undo', onClick: restore } });
toast.error(errorMessage(err));
announce('3 items selected');   // screen readers only, no visual toast
```

Errors are announced assertively, everything else politely. Toasts sit at the top on phones, where the upload panel owns the bottom, and bottom-centre on larger screens.

### Breadcrumbs, Tabs, DropZone, Tooltip, FileName

- `Breadcrumbs`: the last crumb is `aria-current="page"` and gets two lines; on narrow screens the trail scrolls sideways, starting at its end, instead of shortening every name.
- `Tabs`: arrow keys move between tabs (roving focus).
- `DropZone`: drag-and-drop for files and whole folders (`collectDroppedFiles` walks directories). It's a mouse enhancement; there's always a keyboard-accessible Upload button next to it.
- `Tooltip`: supplementary only, never the sole place for information.
- `FileName`: a file name on one line that, cut short, keeps its extension in sight ("Family reunion at the l….pdf"); screen readers get the whole name.

## The file list

[`FileView`](../apps/web/src/features/files/FileView.tsx) is the largest component. It's a WAI-ARIA **grid** used by folders, search, "Shared with me" and public links:

- **Virtualized** against the window scroll: a 10,000-item folder keeps about 17 rows in the DOM (measured).
- **Keyboard:**
  - Arrows move and Shift+arrows extend the selection.
  - Space toggles; Ctrl/Cmd+A selects all; Escape clears.
  - Enter opens, Delete trashes, F2 renames.
  - Shift+F10 or the menu key opens the item's actions.
- **Mouse and touch:** click selects, Ctrl/Shift-click multi-selects, double-click opens. On touch devices a tap opens and a long-press opens the context menu.
- **Infinite scroll** fetches the next page as you near the end.
- Selection is keyed by id, so it survives re-sorting and background refreshes.

## Accessibility checklist (applied to every component)

- Semantic elements first; ARIA only where HTML has no equivalent (the file grid).
- Every interactive element is reachable and operable by keyboard, with a visible focus ring (`:focus-visible`).
- Every control has an accessible name; icons are `aria-hidden`.
- Status changes are announced (`role="status"`, `role="alert"`, the `Announcer`).
- Colour is never the only signal; contrast targets WCAG AA in both themes.
- `prefers-reduced-motion` disables animations.
- Tested: each primitive and key screen runs through **axe-core** in unit tests; Playwright covers real keyboard and mouse flows.

## Testing a component

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectAccessible } from '../../test/utils';

it('toggles', async () => {
  const { container } = render(<SwitchField label="Unlimited" checked={false} onCheckedChange={fn} />);
  await userEvent.click(screen.getByRole('switch', { name: 'Unlimited' }));
  expect(fn).toHaveBeenCalledWith(true);
  await expectAccessible(container);   // axe-core, fails on any WCAG violation it can detect
});
```

Query by role and accessible name (`getByRole('button', { name: 'Save' })`), as a screen-reader user would, never by class or test id.
