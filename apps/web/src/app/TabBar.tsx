import { HardDrive, Images, Search, Users } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { GlassIndicator } from '../components/ui';
import { cn } from '../lib/cn';

/** Each tab also stays selected on the pages its section links lead to (see SectionLinks). */
const TABS = [
  {
    to: '/files',
    label: 'Files',
    icon: HardDrive,
    match: ['/files', '/recent', '/starred', '/trash'],
  },
  { to: '/photos', label: 'Photos', icon: Images, match: ['/photos'] },
  { to: '/shared', label: 'Shared', icon: Users, match: ['/shared', '/shared-by-me'] },
  { to: '/search', label: 'Search', icon: Search, match: ['/search'] },
];

const inSection = (path: string, match: string[]) =>
  match.some((m) => path === m || path.startsWith(`${m}/`));

/**
 * Phone navigation: a floating glass tab bar, always visible so people know where they are.
 * Publishes its height as --tabbar-h so the page and the upload panel stay clear of it.
 */
export function TabBar() {
  const { pathname } = useLocation();
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    // From the bar's top edge to the bottom of the screen. Hidden from md up: nothing to clear.
    const set = () =>
      root.style.setProperty(
        '--tabbar-h',
        el.offsetHeight ? `${window.innerHeight - el.getBoundingClientRect().top}px` : '0px',
      );
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener('resize', set);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', set);
      root.style.removeProperty('--tabbar-h');
    };
  }, []);
  return (
    <nav
      ref={bar}
      aria-label="Main"
      className="glass fixed inset-x-3 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 rounded-full border border-(--glass-edge) shadow-(--glass-shadow) md:hidden"
    >
      <ul className="relative flex p-1">
        <GlassIndicator
          index={TABS.findIndex((t) => inSection(pathname, t.match))}
          count={TABS.length}
          className="bg-accent-soft/80 shadow-[inset_0_1px_0_rgb(255_255_255/0.5),0_1px_4px_rgb(0_0_0/0.08)]"
        />
        {TABS.map(({ to, label, icon: Icon, match }) => {
          const active = inSection(pathname, match);
          return (
            <li key={to} className="relative flex-1">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium transition-[color,transform] duration-300 active:scale-90',
                  active ? 'text-accent' : 'text-text',
                )}
              >
                <Icon size={22} strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
