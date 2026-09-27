import type { Me } from '@familycloud/shared';
import {
  Cloud,
  HardDrive,
  LogOut,
  Menu,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { type FormEvent, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useLogout, useSetupStatus } from '../api/queries';
import { Avatar, DropdownMenu, IconButton, UsageBar } from '../components/ui';
import { UploadPanel } from '../features/uploads/UploadPanel';
import { cn } from '../lib/cn';
import type { ShellContext } from './guards';

const NAV = [
  { to: '/files', label: 'My Files', icon: HardDrive, end: false },
  { to: '/shared', label: 'Shared with me', icon: Users, end: true },
  { to: '/trash', label: 'Trash', icon: Trash2, end: true },
];

function Brand() {
  const setup = useSetupStatus();
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg"
      >
        <Cloud size={18} />
      </span>
      <span className="truncate text-[15px] font-semibold">
        {setup.data?.appName ?? 'Family Cloud'}
      </span>
    </div>
  );
}

function SideNav({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
      isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
    );
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Brand />
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={item} onClick={onNavigate}>
            <Icon size={18} aria-hidden />
            {label}
          </NavLink>
        ))}
        {me.role === 'admin' && (
          <NavLink to="/admin" className={item} onClick={onNavigate}>
            <Shield size={18} aria-hidden />
            Admin
          </NavLink>
        )}
      </nav>
      <div className="mt-auto rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-xs font-medium text-muted">Storage</p>
        <UsageBar used={me.usedBytes} total={me.quotaBytes} label="Your storage use" />
      </div>
    </div>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [q, setQ] = useState(location.pathname === '/search' ? (params.get('q') ?? '') : '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on a form is the widely supported equivalent of <search>
    <form role="search" onSubmit={submit} className="relative w-full max-w-md">
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <label htmlFor="global-search" className="sr-only">
        Search your files
      </label>
      <input
        id="global-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your files"
        className="h-10 w-full rounded-full border border-transparent bg-surface-2 pr-4 pl-9 text-sm placeholder:text-muted focus-visible:border-accent focus-visible:bg-surface focus-visible:outline-none"
      />
    </form>
  );
}

function UserMenu({ me }: { me: Me }) {
  const navigate = useNavigate();
  const logout = useLogout();
  return (
    <DropdownMenu
      label="Account"
      trigger={
        <button
          type="button"
          aria-label={`Account menu for ${me.displayName}`}
          className="rounded-full"
        >
          <Avatar name={me.displayName} size={34} />
        </button>
      }
      actions={[
        {
          id: 'settings',
          label: 'Settings',
          icon: <Settings />,
          onSelect: () => navigate('/settings'),
        },
        {
          id: 'logout',
          label: 'Sign out',
          icon: <LogOut />,
          separatorBefore: true,
          onSelect: () =>
            logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) }),
        },
      ]}
    />
  );
}

export function AppShell({ me }: { me: Me }) {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on navigation to close the drawer
  useEffect(() => setDrawer(false), [location.pathname]);

  const context: ShellContext = { me };
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-bg md:block">
        <SideNav me={me} />
      </aside>

      <D.Root open={drawer} onOpenChange={setDrawer}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in md:hidden" />
          <D.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-border bg-bg shadow-pop animate-fade-in md:hidden">
            <D.Title className="sr-only">Navigation</D.Title>
            <D.Description className="sr-only">Main sections of the app</D.Description>
            <D.Close asChild>
              <IconButton
                label="Close menu"
                icon={<X />}
                className="absolute top-3 right-3"
                noTooltip
              />
            </D.Close>
            <SideNav me={me} onNavigate={() => setDrawer(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-bg/90 px-3 backdrop-blur md:px-6">
          <IconButton
            label="Open menu"
            icon={<Menu />}
            className="md:hidden"
            onClick={() => setDrawer(true)}
            noTooltip
          />
          <SearchBox />
          <div className="ml-auto">
            <UserMenu me={me} />
          </div>
        </header>
        {me.role === 'admin' && !me.totpEnabled && (
          <div className="flex items-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-sm text-warning md:px-6">
            <ShieldCheck size={16} aria-hidden />
            <span>
              Admin accounts should use two-factor sign-in.{' '}
              <NavLink
                to="/settings#security"
                className="font-semibold underline underline-offset-2"
              >
                Turn it on
              </NavLink>
            </span>
          </div>
        )}
        <main
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 px-3 py-4 outline-none md:px-6 md:py-6"
        >
          <Outlet context={context} />
        </main>
      </div>
      <UploadPanel />
    </div>
  );
}
