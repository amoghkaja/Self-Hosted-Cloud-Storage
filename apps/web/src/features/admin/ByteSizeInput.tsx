import { GiB, TiB } from '@familycloud/shared';
import { useEffect, useId, useState } from 'react';
import { SwitchField } from '../../components/ui';

const UNITS = { GB: GiB, TB: TiB } as const;
type Unit = keyof typeof UNITS;

function split(bytes: number): { amount: string; unit: Unit } {
  if (bytes >= TiB && bytes % (TiB / 100) === 0)
    return { amount: String(+(bytes / TiB).toFixed(2)), unit: 'TB' };
  return { amount: String(+(bytes / GiB).toFixed(2)), unit: 'GB' };
}

export interface ByteSizeInputProps {
  label: string;
  value: number | null;
  onChange: (bytes: number | null) => void;
  /** Show an "Unlimited" switch; null means unlimited. */
  unlimitedLabel?: string;
  hint?: string;
}

/** Number + GB/TB picker, with an optional "no limit" switch. Emits bytes (or null). */
export function ByteSizeInput({
  label,
  value,
  onChange,
  unlimitedLabel,
  hint,
}: ByteSizeInputProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => split(value ?? 50 * GiB));
  // Follow outside changes to `value`, but not our own echo of what's being typed: re-deriving
  // the text from bytes would rewrite "0.125" as "0.13", or an emptied field as "0", mid-edit.
  useEffect(() => {
    if (value === null) return;
    setDraft((d) => (Math.round(Number(d.amount) * UNITS[d.unit]) === value ? d : split(value)));
  }, [value]);

  const emit = (amount: string, unit: Unit) => {
    setDraft({ amount, unit });
    const n = Number(amount);
    if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * UNITS[unit]));
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      {unlimitedLabel && (
        <SwitchField
          label={unlimitedLabel}
          checked={value === null}
          onCheckedChange={(on) =>
            onChange(on ? null : Math.round(Number(draft.amount || 0) * UNITS[draft.unit]))
          }
        />
      )}
      {value !== null && (
        <div className="flex gap-2">
          <label htmlFor={`${id}-n`} className="sr-only">
            {label} amount
          </label>
          <input
            id={`${id}-n`}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={draft.amount}
            onChange={(e) => emit(e.target.value, draft.unit)}
            aria-describedby={hint ? `${id}-h` : undefined}
            className="h-10 w-32 rounded-lg pointer-coarse:h-11 border border-border bg-surface px-3 text-sm tabular-nums focus-visible:border-accent"
          />
          <label htmlFor={`${id}-u`} className="sr-only">
            {label} unit
          </label>
          <select
            id={`${id}-u`}
            value={draft.unit}
            onChange={(e) => emit(draft.amount, e.target.value as Unit)}
            className="h-10 rounded-lg border border-border bg-surface px-3 text-sm pointer-coarse:h-11"
          >
            <option>GB</option>
            <option>TB</option>
          </select>
        </div>
      )}
      {hint && (
        <p id={`${id}-h`} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
