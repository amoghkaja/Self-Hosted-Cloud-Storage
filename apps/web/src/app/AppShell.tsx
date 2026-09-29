import type { Me } from '@familycloud/shared';
import {
  ArrowLeft,
  ChevronLeft,
  Clock,
  HardDrive,
  Images,
  LogOut,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useLogout, useSetupStatus } from '../api/queries';
import { Avatar, DropdownMenu } from '../components/ui';
import { InterruptedUploads } from '../features/uploads/InterruptedUploads';
import { UploadPanel } from '../features/uploads/UploadPanel';
import { cn } from '../lib/cn';
import type { ShellContext } from './guards';
import { Logo, LogoMark } from './Logo';
import { PasskeyNudge } from './PasskeyNudge';
import { uploadManager } from './providers';
import { SearchBox } from './SearchBox';
import { StorageSummary } from './StorageSummary';
import { TabBar } from './TabBar';

const NAV = [
  { to: '/files', label: 'My Files', icon: HardDrive, end: false },
  { to: '/recent', label: 'Recent', icon: Clock, end: true },
  { to: '/starred', label: 'Starred', icon: Star, end: true },
  { to: '/photos', label: 'Family Photos', icon: Images, end: false },
  { to: '/shared', label: 'Shared with me', icon: Users, end: true },
  { to: '/shared-by-me', label: 'Shared by me', icon: Share2, end: true },
  { to: '/trash', label: 'Trash', icon: Trash2, end: true },
];

function Brand() {
  return (
    <Link to="/files" className="flex min-w-0 rounded-lg px-2 py-1">
      <Logo />
    </Link>
  );
}

/** Where the family's own site lives (e.g. smithfamily.com), if the admin set one. */
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

/** Larger screens: the sidebar. Phones use the TabBar and the account menu instead. */
function SideNav({ me }: { me: Me }) {
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
          <NavLink key={to} to={to} end={end} className={item}>
            <Icon size={18} aria-hidden />
            {label}
          </NavLink>
        ))}
        {me.role === 'admin' && (
          <NavLink to="/admin" className={item}>
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

function UserMenu({ me }: { me: Me }) {
  const navigate = useNavigate();
  const logout = useLogout();
  const home = useSetupStatus().data?.homeUrl;
  return (
    <DropdownMenu
      label="Account"
      trigger={
        <button
          type="button"
          aria-label={`Account menu for ${me.displayName}`}
          className="flex size-11 items-center justify-center rounded-full"
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
        // Phones have no sidebar: these are its other entries.
        ...(me.role === 'admin'
          ? [{ id: 'admin', label: 'Admin', icon: <Shield />, onSelect: () => navigate('/admin') }]
          : []),
        ...(home
          ? [
              {
                id: 'home',
                label: new URL(home).host,
                icon: <ArrowLeft />,
                onSelect: () => window.location.assign(home),
              },
            ]
          : []),
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

/**
 * Pages reached from the account menu, not a tab. On phones they cover the tab bar, like a
 * pushed settings screen on iOS, and the header offers a way back instead.
 */
const DETAIL_PAGES = ['/settings', '/admin'];

/** Back to where you came from, or to Files when the page was opened directly. */
function BackButton() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      onClick={() => (location.key === 'default' ? navigate('/files') : navigate(-1))}
      className="-ml-2 flex h-11 shrink-0 items-center gap-0.5 rounded-lg pr-3 pl-1 text-base font-medium text-accent md:hidden"
    >
      <ChevronLeft size={24} aria-hidden />
      Back
    </button>
  );
}

export function AppShell({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const detailPage = DETAIL_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const header = useRef<HTMLElement>(null);
  // Sticky bars below the header (page tabs) sit at its real height, which varies with the
  // notch and wrapping.
  useEffect(() => {
    const el = header.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Installed on an iPhone home screen the page runs under the status bar: pad for it.
            Glass: the page scrolls beneath and shows through. */}
        <header
          ref={header}
          className="glass sticky top-0 z-30 flex min-h-16 items-center gap-2 border-b border-(--glass-edge) pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] md:gap-3 md:px-6"
        >
          {detailPage ? (
            <BackButton />
          ) : (
            <Link
              to="/files"
              aria-label="Home"
              className="flex size-11 shrink-0 items-center justify-center md:hidden"
            >
              <LogoMark className="size-8" />
            </Link>
          )}
          <SearchBox id="global-search" className="hidden md:block" />
          <div className="ml-auto">
            <UserMenu me={me} />
          </div>
        </header>
        <InterruptedUploads />
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
          // Extra room at the end while the upload panel (and on phones the tab bar) floats over the
          // bottom of the page.
          className="min-w-0 flex-1 px-3 pt-4 pb-[calc(var(--upload-panel-h,0px)+var(--tabbar-h,0px)+1rem)] outline-none md:px-6 md:pt-6 md:pb-[calc(var(--upload-panel-h,0px)+1.5rem)]"
        >
          <Outlet context={context} />
        </main>
      </div>
      <UploadPanel />
      {!detailPage && <TabBar />}
    </div>
  );
}
