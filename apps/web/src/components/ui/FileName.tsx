import { cn } from '../../lib/cn';

/** ".pdf", ".jpeg", ".docx": a short ending with no spaces (so "Plan v2.0 final" has none). */
const EXTENSION = /\.[^\s.]{1,7}$/;

/**
 * A name on one line that, cut short, keeps its extension in sight ("Family reunion at the
 * l….pdf"), so a narrow list doesn't hide what kind of file it is. Screen readers get the
 * whole name as one piece of text.
 */
export function FileName({ name, className }: { name: string; className?: string }) {
  const ext = name.match(EXTENSION)?.[0];
  if (!ext || ext.length === name.length) {
    return <span className={cn('truncate', className)}>{name}</span>;
  }
  return (
    <span className={cn('flex min-w-0', className)}>
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="truncate">
        {name.slice(0, -ext.length)}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {ext}
      </span>
    </span>
  );
}
