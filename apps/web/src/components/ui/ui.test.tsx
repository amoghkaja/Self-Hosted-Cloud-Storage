import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { copyText } from '../../lib/clipboard';
import { expectAccessible } from '../../test/utils';
import {
  Breadcrumbs,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  PasswordField,
  QueryState,
  SwitchField,
  TextField,
  TooltipProvider,
  UsageBar,
} from './index';

describe('Button', () => {
  it('shows progress, blocks clicks and announces busy while loading', async () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await expectAccessible(container);
  });

  it('renders a link with button styling via asChild', () => {
    render(
      <MemoryRouter>
        <Button asChild variant="primary">
          <a href="/files">Go</a>
        </Button>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Go' })).toHaveClass('bg-primary');
  });
});

describe('fields', () => {
  it('connects label, hint and error for screen readers', async () => {
    const { container, rerender } = render(
      <TextField label="Folder name" hint="Keep it short" defaultValue="" />,
    );
    const input = screen.getByLabelText('Folder name');
    expect(input).toHaveAccessibleDescription('Keep it short');
    rerender(
      <TextField
        label="Folder name"
        hint="Keep it short"
        error="Name cannot be empty"
        defaultValue=""
      />,
    );
    expect(screen.getByLabelText('Folder name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Folder name')).toHaveAccessibleDescription(
      'Name cannot be empty',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name cannot be empty');
    await expectAccessible(container);
  });

  it('toggles password visibility with an accessible button', async () => {
    render(<PasswordField label="Password" defaultValue="secret" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switch is a labelled toggle', async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return (
        <SwitchField
          label="Unlimited"
          description="No quota"
          checked={on}
          onCheckedChange={setOn}
        />
      );
    }
    const { container } = render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Unlimited' });
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await expectAccessible(container);
  });
});

describe('Dialog', () => {
  it('traps focus, has a title, and closes with Escape', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <TooltipProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onOpenChange={setOpen} title="Rename">
            <TextField label="Name" defaultValue="a" autoFocus />
          </Dialog>
        </TooltipProvider>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(dialog).toBeInTheDocument();
    await expectAccessible(dialog);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus());
  });

  it('ConfirmDialog waits for async confirm and stays open on failure', async () => {
    const onOpenChange = vi.fn();
    let reject!: (e: Error) => void;
    const onConfirm = vi.fn(() => new Promise((_res, rej) => (reject = rej)));
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Gone forever"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Delete?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-busy', 'true');
    reject(new Error('nope'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete' })).not.toHaveAttribute('aria-busy'),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('states', () => {
  const base = { isPending: false, isError: false, error: null, refetch: vi.fn() };

  it('QueryState renders loading, error (with retry), empty and data', async () => {
    const props = {
      loading: <p>skeleton</p>,
      empty: <p>nothing</p>,
      isEmpty: (d: string[]) => d.length === 0,
    };
    const { rerender } = render(
      <QueryState query={{ ...base, data: undefined, isPending: true }} {...props}>
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByText('skeleton')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const refetch = vi.fn();
    rerender(
      <QueryState
        query={{
          ...base,
          data: undefined,
          isError: true,
          error: new Error('Server down'),
          refetch,
        }}
        {...props}
      >
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();

    rerender(
      <QueryState query={{ ...base, data: [] as string[] }} {...props}>
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByText('nothing')).toBeInTheDocument();
    rerender(
      <QueryState query={{ ...base, data: ['x'] }} {...props}>
        {(d) => <p>data {d.length}</p>}
      </QueryState>,
    );
    expect(screen.getByText('data 1')).toBeInTheDocument();
  });

  it('EmptyState and ErrorState are accessible', async () => {
    const { container } = render(
      <div>
        <EmptyState
          title="Folder is empty"
          description="Drop files here"
          action={<Button>Upload</Button>}
        />
        <ErrorState error="Oops" onRetry={() => {}} />
      </div>,
    );
    await expectAccessible(container);
  });

  it('UsageBar exposes a named progressbar and warns when over quota', () => {
    render(<UsageBar used={120} total={100} label="Storage" />);
    expect(screen.getByRole('progressbar', { name: 'Storage' })).toBeInTheDocument();
    expect(screen.getByText(/over limit/)).toBeInTheDocument();
  });
});

describe('Breadcrumbs', () => {
  it('marks the current folder and links the rest', async () => {
    const { container } = render(
      <MemoryRouter>
        <Breadcrumbs
          items={[
            { key: '1', label: 'My Files', to: '/files' },
            { key: '2', label: 'Photos' },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'My Files' })).toHaveAttribute('href', '/files');
    expect(screen.getByText('Photos')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: 'Folder path' })).toBeInTheDocument();
    await expectAccessible(container);
  });
});

describe('DropdownMenu', () => {
  it('announces which choice is checked', async () => {
    render(
      <DropdownMenu
        label="Sort"
        trigger={<button type="button">Sort</button>}
        actions={[
          { id: 'a', label: 'Name', checked: true, onSelect: () => {} },
          { id: 'b', label: 'Size', checked: false, onSelect: () => {} },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sort' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Size' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('returns focus to the menu button after a dialog opened from the menu closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <TooltipProvider>
          <DropdownMenu
            label="Actions"
            trigger={<button type="button">Actions</button>}
            actions={[{ id: 'rename', label: 'Rename…', onSelect: () => setOpen(true) }]}
          />
          <Dialog open={open} onOpenChange={setOpen} title="Rename">
            <TextField label="Name" defaultValue="a" autoFocus />
          </Dialog>
        </TooltipProvider>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename' });
    // No description: the title isn't repeated as one.
    expect(dialog).not.toHaveAttribute('aria-describedby');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus());
  });
});

describe('copyText', () => {
  it('falls back to the copy command where the Clipboard API is missing (plain HTTP)', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    try {
      await expect(copyText('https://example.com/s/abc')).resolves.toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
