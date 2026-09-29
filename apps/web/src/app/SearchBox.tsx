import { Search } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { cn } from '../lib/cn';

/** Wait for a pause in typing before searching, so each keystroke isn't a request. */
const TYPING_PAUSE_MS = 250;

/**
 * The search field: in the header on larger screens, on the Search tab on phones. Results
 * follow as you type; Enter searches straight away.
 */
export function SearchBox({
  id,
  autoFocus,
  className,
}: {
  id: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const urlQuery = location.pathname === '/search' ? (params.get('q') ?? '') : '';
  const [q, setQ] = useState(urlQuery);
  // Follow the URL (back/forward between searches, leaving search for a folder), but not back
  // onto what's being typed: "beach " must keep its space while the URL says "beach".
  useEffect(() => setQ((cur) => (cur.trim() === urlQuery ? cur : urlQuery)), [urlQuery]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Leaving for another page cancels a pending search, so it can't pull you back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation only
  useEffect(() => () => clearTimeout(timer.current), [location.pathname]);
  const search = (text: string) => {
    clearTimeout(timer.current);
    const t = text.trim();
    const onSearch = location.pathname === '/search';
    if (!t && !onSearch) return;
    // One history entry per search session: typing replaces it instead of adding one per pause.
    navigate(t ? `/search?q=${encodeURIComponent(t)}` : '/search', { replace: onSearch });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(q);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on a form is the widely supported equivalent of <search>
    <form role="search" onSubmit={submit} className={cn('relative w-full max-w-md', className)}>
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <label htmlFor={id} className="sr-only">
        Search your files
      </label>
      <input
        id={id}
        type="search"
        value={q}
        onChange={(e) => {
          const text = e.target.value;
          setQ(text);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => search(text), TYPING_PAUSE_MS);
        }}
        placeholder="Search"
        // biome-ignore lint/a11y/noAutofocus: the Search tab exists only to type into this field
        autoFocus={autoFocus}
        enterKeyHint="search"
        className="h-10 w-full rounded-full border border-transparent bg-surface-2 pr-4 pl-9 text-sm pointer-coarse:h-11 placeholder:text-muted focus-visible:border-accent focus-visible:bg-surface focus-visible:outline-none"
      />
    </form>
  );
}
