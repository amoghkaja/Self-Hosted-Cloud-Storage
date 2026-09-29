import { Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { cn } from '../lib/cn';

/** The search field: in the header on larger screens, on the Search tab on phones. */
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
  // Follow the URL (back/forward between searches, leaving search for a folder).
  useEffect(() => setQ(urlQuery), [urlQuery]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
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
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search"
        // biome-ignore lint/a11y/noAutofocus: the Search tab exists only to type into this field
        autoFocus={autoFocus}
        enterKeyHint="search"
        className="h-10 w-full rounded-full border border-transparent bg-surface-2 pr-4 pl-9 text-sm pointer-coarse:h-11 placeholder:text-muted focus-visible:border-accent focus-visible:bg-surface focus-visible:outline-none"
      />
    </form>
  );
}
