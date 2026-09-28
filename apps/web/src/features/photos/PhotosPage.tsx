import type { Album } from '@familycloud/shared';
import { Images, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { apiUrl } from '../../api/client';
import { useAlbumMutations, useAlbums, useDirectory } from '../../api/queries';
import { useShell } from '../../app/guards';
import { Avatar, Button, EmptyState, QueryState, Skeleton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { usePageTitle } from '../../lib/usePageTitle';
import { TripDialog, tripDates } from './TripForm';

export function coverUrl(a: Album) {
  return a.cover?.thumb === 'ready'
    ? apiUrl(`/albums/${a.id}/photos/${a.cover.nodeId}/thumbnail`, { size: '1600' })
    : null;
}

function People({ people, size = 24 }: { people: Album['people']; size?: number }) {
  if (people.length === 0) return null;
  return (
    <span className="flex items-center">
      <span className="sr-only">{people.map((p) => p.displayName).join(', ')}</span>
      {people.slice(0, 5).map((p) => (
        <span key={p.id} className="-mr-1.5 rounded-full ring-2 ring-surface" title={p.displayName}>
          <Avatar name={p.displayName} size={size} />
        </span>
      ))}
      {people.length > 5 && <span className="ml-3 text-xs text-muted">+{people.length - 5}</span>}
    </span>
  );
}

function AlbumCard({ a }: { a: Album }) {
  const cover = coverUrl(a);
  return (
    <li>
      <Link
        to={`/photos/${a.id}`}
        className="group block overflow-hidden rounded-2xl border border-border bg-surface focus-visible:outline-2"
      >
        <div className="aspect-[4/3] overflow-hidden bg-surface-2">
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-muted">
              <Images size={32} aria-hidden />
            </div>
          )}
        </div>
        <div className="flex items-end gap-3 p-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-serif text-xl leading-tight">{a.title}</h3>
            <p className="mt-1 text-sm text-muted">
              {tripDates(a.startDate, a.endDate)} · {a.photoCount}{' '}
              {a.photoCount === 1 ? 'photo' : 'photos'}
            </p>
          </div>
          <People people={a.people} />
        </div>
      </Link>
    </li>
  );
}

/** All the family's trips, newest first, grouped by year, filterable by who went. */
export function PhotosPage() {
  const { me } = useShell();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const person = params.get('person');
  const q = useAlbums(person);
  const directory = useDirectory();
  const m = useAlbumMutations();
  const [creating, setCreating] = useState(false);
  usePageTitle('Photos');

  const family = [{ id: me.id, displayName: me.displayName }, ...(directory.data?.items ?? [])];
  const years = useMemo(() => {
    const groups = new Map<string, Album[]>();
    for (const a of q.data?.items ?? []) {
      const y = a.startDate.slice(0, 4);
      groups.set(y, [...(groups.get(y) ?? []), a]);
    }
    return [...groups];
  }, [q.data]);

  const chip = (active: boolean) =>
    cn(
      'flex h-10 pointer-coarse:h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm transition-colors',
      active ? 'border-accent bg-accent-soft font-medium' : 'border-border hover:bg-surface-2',
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-[0.22em] text-accent uppercase">
            Family trips
          </p>
          <h1 className="font-display text-4xl leading-tight sm:text-5xl">Photos</h1>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
          New trip
        </Button>
      </div>

      <nav aria-label="Filter by person" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <button
          type="button"
          className={chip(!person)}
          aria-pressed={!person}
          onClick={() => setParams({}, { replace: true })}
        >
          Everyone
        </button>
        {family.map((p) => (
          <button
            key={p.id}
            type="button"
            className={chip(person === p.id)}
            aria-pressed={person === p.id}
            onClick={() => setParams({ person: p.id }, { replace: true })}
          >
            <Avatar name={p.displayName} size={24} />
            {p.id === me.id ? 'You' : p.displayName}
          </button>
        ))}
      </nav>

      <QueryState
        query={q}
        loading={
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-[4/3.6] rounded-2xl" />
            ))}
          </div>
        }
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Images />}
            title={person ? 'No trips with them yet' : 'No trips yet'}
            description="Make an album for a trip, tick who went, and everyone can add their photos from their phone."
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
                New trip
              </Button>
            }
          />
        }
      >
        {() => (
          <div className="flex flex-col gap-10">
            {years.map(([year, list]) => (
              <section key={year} aria-labelledby={`year-${year}`}>
                <h2
                  id={`year-${year}`}
                  className="mb-4 border-b border-border pb-2 font-display text-3xl"
                >
                  {year}
                </h2>
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((a) => (
                    <AlbumCard key={a.id} a={a} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryState>

      {creating && (
        <TripDialog
          me={me}
          title="New trip"
          submitLabel="Create trip"
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const a = await m.create.mutateAsync(input);
            setCreating(false);
            navigate(`/photos/${a.id}`);
          }}
        />
      )}
    </div>
  );
}
