import type { ReleaseNotes } from '@familycloud/shared';
import { Fragment } from 'react';
import { useAbout } from '../../api/queries';
import { EmptyState, QueryState, Skeleton } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { usePageTitle } from '../../lib/usePageTitle';

/** A changelog line with its `**bold**` and `code` marks turned into elements. */
function Line({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
        const key = i;
        if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`'))
          return (
            <code key={key} className="font-mono text-[13px]">
              {part.slice(1, -1)}
            </code>
          );
        return <Fragment key={key}>{part}</Fragment>;
      })}
    </>
  );
}

function Release({ release, running }: { release: ReleaseNotes; running: boolean }) {
  const unreleased = release.version === 'Unreleased';
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{unreleased ? 'Latest changes' : release.version}</h2>
        {release.date && <span className="text-sm text-muted">{formatDate(release.date)}</span>}
        {running && <span className="text-sm text-muted">This is what you're using</span>}
      </div>
      <div className="flex flex-col gap-4">
        {release.groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1.5 text-sm font-medium text-muted">{g.title}</h3>
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {g.items.map((item) => (
                <li key={item}>
                  <Line text={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** What changed in each release, from the changelog that ships with the server. */
export function WhatsNewPage() {
  const about = useAbout();
  usePageTitle("What's new");
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">What's new</h1>
      <QueryState
        query={about}
        loading={<Skeleton className="h-64" />}
        isEmpty={(d) => d.releases.length === 0}
        empty={<EmptyState title="No release notes with this version" className="py-10" />}
      >
        {(d) => (
          <>
            <p className="text-sm text-muted">This server is running Family Cloud {d.version}.</p>
            {d.releases.map((r) => (
              <Release
                key={r.version}
                release={r}
                // A build made after a release (v0.4.0-5-gabc1234) runs the Unreleased changes.
                running={
                  r.version === d.version ||
                  (r.version === 'Unreleased' && !d.releases.some((x) => x.version === d.version))
                }
              />
            ))}
          </>
        )}
      </QueryState>
    </div>
  );
}
