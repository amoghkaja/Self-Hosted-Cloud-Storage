import type { Me } from '@familycloud/shared';
import {
  ArrowLeft,
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
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useLogout, useSetupStatus } from '../api/queries';
import { Avatar, DropdownMenu, IconButton } from '../components/ui';
import { UploadPanel } from '../features/uploads/UploadPanel';
import { cn } from '../lib/cn';
import { type ThemeChoice, useTheme } from '../lib/theme';
import type { ShellContext } from './guards';
import { Logo, LogoMark } from './Logo';
import { PasskeyNudge } from './PasskeyNudge';
import { uploadManager } from './providers';
import { StorageSummary } from './StorageSummary';

const NAV = [
  { to: '/files', label: 'My Files', icon: HardDrive, end: false },
  { to: '/shared', label: 'Shared with me', icon: Users, end: true },
  { to: '/trash', label: 'Trash', icon: Trash2, end: true },
];

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/files" onClick={onNavigate} className="flex min-w-0 rounded-lg px-2 py-1">
      <Logo />
    </Link>
  );
}

/** Where the family's own site lives (e.g. kajafamily.com), if the admin set one. */
function HomeLink() {
  const home = useSetupStatus().data?.homeUrl;
  if (!home) return null;
  return (
    <a
      href={home}
      className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-text"
    >
      <ArrowLeft size={16} aria-hidden />
      <span className="truncate">{new URL(home).host}</span>
    </a>
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
      <Brand onNavigate={onNavigate} />
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
      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="mb-2 text-xs font-medium text-muted">Storage</p>
          <StorageSummary />
        </div>
        <HomeLink />
      </div>
    </div>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const urlQuery = location.pathname === '/search' ? (params.get('q') ?? '') : '';
  const [q, setQ] = useState(urlQuery);
  // Follow the URL (back/forward between searches, leaving search for a folder).
  useEffect(() => setQ(urlQuery), [urlQuery]);
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
  const [theme, setTheme] = useTheme();
  const themes: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: 'Match device' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
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
        ...themes.map((t, i) => ({
          id: `theme-${t.id}`,
          label: t.label,
          checked: theme === t.id,
          separatorBefore: i === 0,
          onSelect: () => setTheme(t.id),
        })),
        {
          id: 'logout',
          label: 'Sign out',
          icon: <LogOut />,
          separatorBefore: true,
          onSelect: () => {
            // Stop uploads and clear the list: the next person to sign in mustn't see it.
            uploadManager.reset();
            logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });
          },
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

  // Files dropped anywhere outside an upload area (sidebar, header, a missed target) would make
  // the browser navigate away to open them, abandoning the app and any uploads in progress.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
      e.preventDefault();
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

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
          <Link to="/files" aria-label="Home" className="shrink-0 md:hidden">
            <LogoMark className="size-8" />
          </Link>
          <SearchBox />
          <div className="ml-auto">
            <UserMenu me={me} />
          </div>
        </header>
        <PasskeyNudge />
        {me.role === 'admin' && !me.totpEnabled && (
          <section
            aria-label="Security reminder"
            className="flex items-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-sm text-warning md:px-6"
          >
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
          </section>
        )}
        <main
          id="main"
          tabIndex={-1}
          // Extra room at the end while the upload panel floats over the bottom of the page.
          className="min-w-0 flex-1 px-3 pt-4 pb-[calc(var(--upload-panel-h,0px)+1rem)] outline-none md:px-6 md:pt-6 md:pb-[calc(var(--upload-panel-h,0px)+1.5rem)]"
        >
          <Outlet context={context} />
        </main>
      </div>
      <UploadPanel />
    </div>
  );
}
