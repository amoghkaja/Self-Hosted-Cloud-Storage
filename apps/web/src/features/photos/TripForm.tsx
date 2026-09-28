import type { Me } from '@familycloud/shared';
import { Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { type AlbumInput, useDirectory } from '../../api/queries';
import { Avatar, Button, Dialog, TextField } from '../../components/ui';
import { cn } from '../../lib/cn';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

/**
 * New trip / edit trip: a name, the dates (the phone's own calendar picker) and who went.
 * Everyone ticked can add their photos; the whole family can see the album.
 */
export function TripDialog({
  me,
  initial,
  title,
  submitLabel,
  onSubmit,
  onClose,
}: {
  me: Me;
  initial?: AlbumInput;
  title: string;
  submitLabel: string;
  onSubmit: (input: AlbumInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const directory = useDirectory();
  const family = [
    { id: me.id, displayName: me.displayName },
    ...(directory.data?.items ?? []).map(({ id, displayName }) => ({ id, displayName })),
  ];
  const [name, setName] = useState(initial?.title ?? '');
  const [start, setStart] = useState(initial?.startDate ?? today());
  const [end, setEnd] = useState(initial?.endDate ?? '');
  const [people, setPeople] = useState<Set<string>>(new Set(initial?.peopleIds ?? [me.id]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endError = end && end < start ? 'The trip can’t end before it starts.' : null;

  const toggle = (id: string) =>
    setPeople((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || endError) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: name.trim(),
        startDate: start,
        endDate: end || null,
        peopleIds: [...people],
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="Everyone you tick can add their photos. The whole family can see the album."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !!endError}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <TextField
          label="Trip name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Goa beach holiday"
          maxLength={120}
          autoFocus
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="From"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
          <TextField
            label="To (optional)"
            type="date"
            value={end}
            min={start}
            onChange={(e) => setEnd(e.target.value)}
            error={endError}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Who went?</legend>
          <div className="flex flex-wrap gap-2">
            {family.map((p) => {
              const on = people.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(p.id)}
                  className={cn(
                    'flex h-11 items-center gap-2 rounded-full border pr-4 pl-1.5 text-sm transition-colors',
                    on
                      ? 'border-accent bg-accent-soft font-medium'
                      : 'border-border hover:bg-surface-2',
                  )}
                >
                  <Avatar name={p.displayName} size={30} />
                  {p.id === me.id ? `${p.displayName} (you)` : p.displayName}
                  {on && <Check size={16} className="text-accent" aria-hidden />}
                </button>
              );
            })}
          </div>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const FULL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "12 – 18 Aug 2026", "30 Dec 2025 – 2 Jan 2026" or "24 Dec 2025". */
export function tripDates(startDate: string, endDate: string | null) {
  const s = new Date(`${startDate}T12:00:00`);
  if (!endDate || endDate === startDate) return FULL.format(s);
  const e = new Date(`${endDate}T12:00:00`);
  if (s.getFullYear() !== e.getFullYear()) return `${FULL.format(s)} – ${FULL.format(e)}`;
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()} – ${e.getDate()} ${MONTH.format(e)} ${e.getFullYear()}`;
  }
  return `${DAY_MONTH.format(s)} – ${FULL.format(e)}`;
}
