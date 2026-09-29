import { Eye, EyeOff } from 'lucide-react';
import { Switch as S } from 'radix-ui';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from '../../lib/cn';

const control =
  'h-10 pointer-coarse:h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-60 aria-[invalid=true]:border-danger';

interface FieldChrome {
  label: ReactNode;
  /** Helper text below the control. */
  hint?: ReactNode;
  /** Error message; also marks the control aria-invalid. */
  error?: string | null;
  /** Visually hide the label but keep it for screen readers. */
  hideLabel?: boolean;
}

/** Wires label, hint and error to the control with the right ids (aria-describedby). */
function useFieldIds(id?: string) {
  const auto = useId();
  const controlId = id ?? auto;
  return { controlId, hintId: `${controlId}-hint`, errorId: `${controlId}-error` };
}

function Chrome({
  label,
  hint,
  error,
  hideLabel,
  ids,
  children,
  className,
}: FieldChrome & { ids: ReturnType<typeof useFieldIds>; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={ids.controlId} className={cn('text-sm font-medium', hideLabel && 'sr-only')}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={ids.hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={ids.errorId} className="text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(ids: ReturnType<typeof useFieldIds>, hint: unknown, error: unknown) {
  return error ? ids.errorId : hint ? ids.hintId : undefined;
}

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'size'>, FieldChrome {
  containerClassName?: string;
  /** Element rendered at the end of the input (unit, button). */
  trailing?: ReactNode;
}

export function TextField({
  label,
  hint,
  error,
  hideLabel,
  id,
  className,
  containerClassName,
  trailing,
  ...props
}: TextFieldProps) {
  const ids = useFieldIds(id);
  return (
    <Chrome
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      ids={ids}
      className={containerClassName}
    >
      <div className="relative flex items-center">
        <input
          id={ids.controlId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, hint, error)}
          className={cn(control, trailing ? 'pr-11' : undefined, className)}
          {...props}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</div>
        )}
      </div>
    </Chrome>
  );
}

export function PasswordField(props: Omit<TextFieldProps, 'type' | 'trailing'>) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="inline-flex size-8 pointer-coarse:size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
        >
          {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      }
    />
  );
}

export interface TextAreaFieldProps extends ComponentProps<'textarea'>, FieldChrome {
  containerClassName?: string;
}

/** Multi-line text, with the same label, hint and error wiring as TextField. */
export function TextAreaField({
  label,
  hint,
  error,
  hideLabel,
  id,
  className,
  containerClassName,
  ...props
}: TextAreaFieldProps) {
  const ids = useFieldIds(id);
  return (
    <Chrome
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      ids={ids}
      className={containerClassName}
    >
      <textarea
        id={ids.controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(control, 'h-auto min-h-24 py-2 leading-relaxed', className)}
        {...props}
      />
    </Chrome>
  );
}

export interface SelectFieldProps extends ComponentProps<'select'>, FieldChrome {
  containerClassName?: string;
}

/** Native select: best keyboard, screen-reader and mobile behaviour for free. */
export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  id,
  className,
  containerClassName,
  children,
  ...props
}: SelectFieldProps) {
  const ids = useFieldIds(id);
  return (
    <Chrome
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      ids={ids}
      className={containerClassName}
    >
      <select
        id={ids.controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(control, 'pr-8', className)}
        {...props}
      >
        {children}
      </select>
    </Chrome>
  );
}

export interface SwitchFieldProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export function SwitchField({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  id,
}: SwitchFieldProps) {
  const ids = useFieldIds(id);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col">
        <label htmlFor={ids.controlId} className="text-sm font-medium">
          {label}
        </label>
        {description && (
          <p id={ids.hintId} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
      <S.Root
        id={ids.controlId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? ids.hintId : undefined}
        className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-surface-3 after:absolute after:-inset-2.5 after:content-[''] transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <S.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </S.Root>
    </div>
  );
}

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: string;
  /** Hide the visible label (still announced). */
  hideLabel?: boolean;
}

export function Checkbox({ label, hideLabel, className, ...props }: CheckboxProps) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input
        type="checkbox"
        className="size-4 cursor-pointer rounded border-border-strong accent-[var(--accent)]"
        {...props}
      />
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    </label>
  );
}
