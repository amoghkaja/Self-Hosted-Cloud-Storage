import type {
  CreateAppPasswordResponse,
  Me,
  Passkey,
  RecoveryCodeStatus,
  TotpEnableResponse,
} from '@familycloud/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Fingerprint,
  HardDrive,
  KeyRound,
  Laptop,
  Monitor,
  Moon,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import {
  qk,
  useAbout,
  useAppPasswordMutations,
  useAppPasswords,
  usePasskeyMutations,
  usePasskeys,
  useSessions,
  useSetupStatus,
} from '../../api/queries';
import { useShell } from '../../app/guards';
import { StorageSummary } from '../../app/StorageSummary';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  PasswordField,
  QueryState,
  Skeleton,
  Tabs,
  TextField,
  toast,
} from '../../components/ui';
import { copyText } from '../../lib/clipboard';
import { describeUserAgent, formatRelative } from '../../lib/format';
import { passkeyError, passkeysSupported } from '../../lib/passkeys';
import { type ThemeChoice, useTheme } from '../../lib/theme';
import { usePageTitle } from '../../lib/usePageTitle';
import { ConfirmPasswordDialog } from './ConfirmPasswordDialog';

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  // A generated id: titles contain spaces, which aria-labelledby would read as several ids.
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="rounded-2xl border border-border bg-surface p-5"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ProfileSection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(
        qk.me,
        await api<Me>('/auth/me', { method: 'PATCH', json: { displayName: name } }),
      );
      toast.success('Name updated');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Profile">
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <TextField
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          containerClassName="flex-1"
          required
          maxLength={80}
        />
        <TextField label="Email" value={me.email} readOnly containerClassName="flex-1" />
        <Button type="submit" loading={busy} disabled={name.trim() === me.displayName}>
          Save
        </Button>
      </form>
      <div className="mt-5">
        <p className="mb-2 text-sm font-medium">Your storage</p>
        <StorageSummary detailed />
      </div>
    </Section>
  );
}

function PasswordSection() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'current' | 'next'; message: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', { json: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      toast.success('Password changed. Other devices were signed out.');
      void qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (err) {
      setError({
        field: err instanceof ApiError && err.code === 'INVALID_CREDENTIALS' ? 'current' : 'next',
        message: errorMessage(err),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Password" description="Changing it signs you out everywhere else.">
      <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={error?.field === 'current' ? error.message : null}
          required
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint="At least 10 characters."
          minLength={10}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={error?.field === 'next' ? error.message : null}
          required
        />
        <Button type="submit" loading={busy} className="self-start">
          Change password
        </Button>
      </form>
    </Section>
  );
}

/** Recovery codes, shown once: keep them somewhere safe, off the phone that has the app. */
function RecoveryCodesPanel({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Family Cloud recovery codes. Each works once, in place of the code from your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex max-w-md flex-col gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4">
      <p className="text-sm font-medium">Save your recovery codes</p>
      <p className="text-sm">
        If you lose your phone, each of these gets you in once instead of a code. Keep them
        somewhere safe that isn't that phone (printed, or in a password manager). You won't see them
        again.
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-surface px-3 py-2 font-mono text-sm select-all">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            if (await copyText(codes.join('\n'))) toast.success('Codes copied');
            else toast.error('Copy failed. Select the codes and copy them manually.');
          }}
        >
          Copy
        </Button>
        <Button size="sm" onClick={download}>
          Download
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}

function RecoveryCodesStatus() {
  const status = useQuery({
    queryKey: ['recovery-codes'],
    queryFn: () => api<RecoveryCodeStatus>('/auth/recovery-codes'),
  });
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (codes) {
    return (
      <RecoveryCodesPanel
        codes={codes}
        onDone={() => {
          setCodes(null);
          void qc.invalidateQueries({ queryKey: ['recovery-codes'] });
        }}
      />
    );
  }
  const left = status.data?.remaining;
  const renew = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCodes(
        (await api<{ codes: string[] }>('/auth/recovery-codes', { json: { password } })).codes,
      );
      setAsking(false);
      setPassword('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex max-w-md flex-col gap-2 border-t border-border pt-4">
      <p className="text-sm">
        <span className="font-medium">Recovery codes: </span>
        {left === undefined ? '…' : left === 1 ? '1 left' : `${left} left`}
        {left !== undefined && left <= 3 && '. Get new ones before you run out.'}
      </p>
      {asking ? (
        <form onSubmit={renew} className="flex flex-col gap-3">
          <PasswordField
            label="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="New codes replace the old ones."
            autoFocus
            required
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Get new codes
            </Button>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button className="self-start" onClick={() => setAsking(true)}>
          Get new recovery codes
        </Button>
      )}
    </div>
  );
}

export function TwoFactorSection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; url: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const start = async (password: string) => {
    const res = await api<{ secret: string; otpauthUrl: string }>('/auth/totp/setup', {
      json: { password },
    });
    setSetup({
      secret: res.secret,
      url: res.otpauthUrl,
      qr: await QRCode.toDataURL(res.otpauthUrl, { margin: 1, width: 200 }),
    });
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { recoveryCodes, ...updated } = await api<TotpEnableResponse>('/auth/totp/enable', {
        json: { code },
      });
      qc.setQueryData(qk.me, updated);
      setSetup(null);
      setCode('');
      setNewCodes(recoveryCodes);
      toast.success('Two-factor sign-in is on');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(
        qk.me,
        await api<Me>('/auth/totp/disable', {
          json: useRecovery ? { password, recoveryCode: code } : { password, code },
        }),
      );
      setCode('');
      setPassword('');
      setUseRecovery(false);
      toast.success('Two-factor sign-in is off');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="security"
      title="Two-factor sign-in"
      description="Ask for a code from an authenticator app (Google Authenticator, 1Password, iPhone Passwords) when signing in on the web."
    >
      {newCodes ? (
        <RecoveryCodesPanel codes={newCodes} onDone={() => setNewCodes(null)} />
      ) : me.totpEnabled ? (
        <div className="flex flex-col gap-4">
          <form onSubmit={disable} className="flex max-w-md flex-col gap-3">
            <Badge tone="success" className="self-start">
              <ShieldCheck size={12} aria-hidden /> On
            </Badge>
            <p className="text-sm text-muted">To turn it off, confirm it's you:</p>
            <PasswordField
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {useRecovery ? (
              <TextField
                label="Recovery code"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={40}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            ) : (
              <TextField
                label="Current code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required
              />
            )}
            <button
              type="button"
              className="self-start text-sm text-accent underline-offset-2 hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
              }}
            >
              {useRecovery ? 'Use the code from your app' : 'Lost your phone? Use a recovery code'}
            </button>
            <Button type="submit" variant="danger" loading={busy} className="self-start">
              Turn off
            </Button>
          </form>
          <RecoveryCodesStatus />
        </div>
      ) : setup ? (
        <form onSubmit={enable} className="flex flex-col gap-4 sm:flex-row">
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            width={200}
            height={200}
            className="rounded-lg bg-white p-2"
          />
          <div className="flex max-w-sm flex-col gap-3">
            <p className="text-sm">Scan the code with your authenticator app, or enter this key:</p>
            <CopyRow label="Key" value={setup.secret} />
            {/* Setting up on the phone that has the app: there's nothing to scan the code with. */}
            <Button asChild className="self-start pointer-fine:hidden">
              <a href={setup.url}>Open in your authenticator app</a>
            </Button>
            <TextField
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                Turn on
              </Button>
              <Button onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </div>
        </form>
      ) : (
        <Button
          variant="primary"
          icon={<ShieldCheck size={16} />}
          onClick={() => setConfirming(true)}
        >
          Set up two-factor
        </Button>
      )}
      <ConfirmPasswordDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Set up two-factor"
        onConfirm={start}
      />
    </Section>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">{value}</code>
      <Button
        size="sm"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          if (await copyText(value)) toast.success(`${label} copied`);
          else toast.error('Copy failed. Select the text and copy it manually.');
        }}
      >
        Copy
      </Button>
    </div>
  );
}

function guessDevice(): 'mac' | 'windows' | 'iphone' {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  // iPadOS calls itself a Mac; only the touch screen gives it away.
  if (/iPhone|iPad/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1))
    return 'iphone';
  return 'mac';
}

/** One paste into Command Prompt: saves the password, then maps a drive that survives a restart. */
function windowsCommand(creds: CreateAppPasswordResponse): string | null {
  const url = new URL(creds.davUrl);
  // Windows refuses to send a password to a WebDAV server over plain http.
  if (url.protocol !== 'https:') return null;
  const share = `\\\\${url.hostname}@SSL${url.port ? `@${url.port}` : ''}${url.pathname.replace(/\/$/, '').replaceAll('/', '\\')}`;
  return `cmdkey /add:${url.hostname} /user:${creds.username} /pass:${creds.password} && net use * ${share} /persistent:yes`;
}

export function ConnectGuide({ creds }: { creds: CreateAppPasswordResponse }) {
  const [tab, setTab] = useState<string>(guessDevice);
  const command = windowsCommand(creds);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <CopyRow label="Server" value={creds.davUrl} />
        <CopyRow label="Username" value={creds.username} />
        <CopyRow label="Password" value={creds.password} />
        <p className="text-xs text-muted">
          This password is shown only once. It works only for the network drive, and you can remove
          it any time.
        </p>
      </div>
      <Tabs
        label="Device type"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'mac',
            label: 'Mac',
            content: (
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>
                  In Finder, choose <strong>Go → Connect to Server…</strong> (⌘K).
                </li>
                <li>
                  Enter the server address above and click <strong>Connect</strong>.
                </li>
                <li>
                  Choose <strong>Registered User</strong>, enter the username and password above,
                  and tick <strong>Remember this password in my keychain</strong>.
                </li>
                <li className="text-muted">
                  To keep it handy, drag the drive into the Finder sidebar. To reconnect whenever
                  you log in, add it under System Settings → General → Login Items.
                </li>
              </ol>
            ),
          },
          {
            value: 'windows',
            label: 'Windows',
            content: (
              <div className="flex flex-col gap-3 text-sm">
                {command && (
                  <>
                    <p>
                      Press <strong>Win + R</strong>, type <strong>cmd</strong>, press Enter, then
                      paste this and press Enter. The drive appears under This PC and comes back
                      after a restart.
                    </p>
                    <CopyRow label="Command" value={command} />
                    <p>Or set it up by hand:</p>
                  </>
                )}
                <ol className="list-decimal space-y-2 pl-5">
                  <li>
                    Open File Explorer, right-click <strong>This PC</strong> →{' '}
                    <strong>Map network drive…</strong>
                  </li>
                  <li>
                    Paste the server address as the folder, tick{' '}
                    <strong>Connect using different credentials</strong>, click{' '}
                    <strong>Finish</strong>.
                  </li>
                  <li>Enter the username and password above.</li>
                  <li className="text-muted">
                    Windows won't open files over 50 MB from a network drive until its limit is
                    raised. Use the website for those, or ask whoever runs the server.
                  </li>
                </ol>
              </div>
            ),
          },
          {
            value: 'iphone',
            label: 'iPhone / iPad',
            content: (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  The Files app can't connect to this kind of drive on its own. The simplest way is
                  the website: open it in Safari, tap <strong>Share</strong> →{' '}
                  <strong>Add to Home Screen</strong>, and it works like an app.
                </p>
                <p>To see Family Cloud inside the Files app, you need a free helper app:</p>
                <ol className="list-decimal space-y-2 pl-5">
                  <li>
                    Install one that adds itself to Files, such as <strong>Owlfiles</strong> or{' '}
                    <strong>FE File Explorer</strong> from the App Store.
                  </li>
                  <li>
                    In that app, add a <strong>WebDAV</strong> connection using the server, username
                    and password above.
                  </li>
                  <li>
                    Open the <strong>Files</strong> app → <strong>Browse</strong> → tap{' '}
                    <strong>⋯</strong> → <strong>Edit</strong>, and switch on the helper app. Family
                    Cloud now appears next to iCloud Drive.
                  </li>
                  <li className="text-muted">
                    Away from home, single files over 100 MB can't upload this way. Use the
                    website's Upload button for long videos.
                  </li>
                </ol>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function DevicesSection() {
  const list = useAppPasswords();
  const m = useAppPasswordMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [creds, setCreds] = useState<CreateAppPasswordResponse | null>(null);
  const [remove, setRemove] = useState<{ id: string; name: string } | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    try {
      setCreds(await m.create.mutateAsync({ name: name.trim(), password }));
      setPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setPasswordError(errorMessage(err));
      } else {
        toast.error(errorMessage(err));
      }
    }
  };
  const close = () => {
    setOpen(false);
    setCreds(null);
    setName('');
    setPassword('');
    setPasswordError(null);
  };

  return (
    <Section
      id="devices"
      title="Network drive"
      description="Open your files in Finder or Windows Explorer like any other drive. Each device gets its own password you can remove if it's lost."
    >
      <QueryState
        query={list}
        loading={<Skeleton className="h-14" />}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon={<HardDrive />} title="No devices connected" className="py-6" />}
      >
        {(d) => (
          <ul className="mb-4 divide-y divide-border rounded-xl border border-border">
            {d.items.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <KeyRound size={18} className="text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted">
                    {p.lastUsedAt ? `Last used ${formatRelative(p.lastUsedAt)}` : 'Never used'}
                  </p>
                </div>
                <IconButton
                  label={`Remove ${p.name}`}
                  icon={<Trash2 />}
                  onClick={() => setRemove({ id: p.id, name: p.name })}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Button variant="primary" icon={<Smartphone size={16} />} onClick={() => setOpen(true)}>
        Connect a device
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => !o && close()}
        title={creds ? 'Connect your device' : 'Connect a device'}
        size="md"
        footer={
          creds ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : undefined
        }
      >
        {creds ? (
          <ConnectGuide creds={creds} />
        ) : (
          <form onSubmit={create} className="flex flex-col gap-3">
            <TextField
              label="Device name"
              placeholder="e.g. Mom's iPad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
              required
            />
            {/* The device password opens every file, so it's yours to confirm first. */}
            <PasswordField
              label="Your password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordError}
              required
            />
            <Button
              type="submit"
              variant="primary"
              loading={m.create.isPending}
              disabled={!name.trim() || !password}
              className="self-start"
            >
              Create password
            </Button>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        tone="danger"
        title={`Remove “${remove?.name}”?`}
        description="That device will be disconnected from the network drive right away."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await m.revoke.mutateAsync(remove!.id);
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </Section>
  );
}

function SessionsSection() {
  const sessions = useSessions();
  const qc = useQueryClient();
  const revoke = async (id: string) => {
    try {
      await api(`/auth/sessions/${id}`, { method: 'DELETE' });
      void qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Section title="Where you're signed in">
      <QueryState query={sessions} loading={<Skeleton className="h-24" />}>
        {(d) => (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {d.items.map((s) => {
              const phone = /iPhone|Android|iPad/.test(s.userAgent ?? '');
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  {phone ? (
                    <Smartphone size={18} className="text-muted" aria-hidden />
                  ) : s.userAgent?.includes('Mac') ? (
                    <Laptop size={18} className="text-muted" aria-hidden />
                  ) : (
                    <Monitor size={18} className="text-muted" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {describeUserAgent(s.userAgent)}{' '}
                      {s.current && <Badge tone="accent">This device</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted">
                      Active {formatRelative(s.lastSeenAt)}
                      {s.ip ? ` · ${s.ip}` : ''}
                    </p>
                  </div>
                  {!s.current && (
                    <Button size="sm" onClick={() => void revoke(s.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

function PasskeysSection() {
  const q = usePasskeys();
  const m = usePasskeyMutations();
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [confirming, setConfirming] = useState(false);
  const supported = passkeysSupported();
  const add = async (password: string) => {
    try {
      const p = await m.add.mutateAsync(password);
      toast.success(`Passkey added for ${p.name}. Next time, sign in with Face ID or Touch ID.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') throw err;
      const message = passkeyError(err);
      if (message) toast.error(message);
    }
  };
  return (
    <Section
      id="passkeys"
      title="Passkeys"
      description="Sign in with Face ID, Touch ID or your device PIN instead of typing a password. A passkey saved in iCloud Keychain works on all your Apple devices."
    >
      <QueryState
        query={q}
        loading={<Skeleton className="h-16" />}
        isEmpty={(items) => items.length === 0}
        empty={
          <p className="mb-3 text-sm text-muted">
            {supported
              ? 'No passkeys yet.'
              : 'This browser can’t create passkeys. Try Safari on your iPhone or Mac.'}
          </p>
        }
      >
        {(items) => (
          <ul className="mb-3 divide-y divide-border">
            {items.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <Fingerprint size={18} className="shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted">
                    {p.backedUp ? 'Synced across your devices' : 'This device only'} · added{' '}
                    {formatRelative(p.createdAt)}
                    {p.lastUsedAt && `, last used ${formatRelative(p.lastUsedAt)}`}
                  </p>
                </div>
                <IconButton
                  label={`Remove passkey ${p.name}`}
                  icon={<Trash2 />}
                  onClick={() => setRemoving(p)}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {supported && (
        <Button icon={<Fingerprint size={16} />} onClick={() => setConfirming(true)}>
          Add a passkey
        </Button>
      )}
      <ConfirmPasswordDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Add a passkey"
        onConfirm={add}
      />
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove the passkey “${removing.name}”?`}
          description="It won’t sign you in any more. Also delete it from your device’s passwords list to tidy up."
          confirmLabel="Remove"
          tone="danger"
          onConfirm={async () => {
            try {
              await m.remove.mutateAsync(removing.id);
              setRemoving(null);
              toast.success('Passkey removed');
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        />
      )}
    </Section>
  );
}

function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const options: { id: ThemeChoice; label: string; icon: ReactNode }[] = [
    { id: 'system', label: 'Match device', icon: <Monitor size={16} aria-hidden /> },
    { id: 'light', label: 'Light', icon: <Sun size={16} aria-hidden /> },
    { id: 'dark', label: 'Dark', icon: <Moon size={16} aria-hidden /> },
  ];
  return (
    <Section title="Appearance" description="Saved on this device.">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Theme</legend>
        {options.map((o) => (
          <label
            key={o.id}
            className="flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
          >
            <input
              type="radio"
              name="theme"
              value={o.id}
              checked={theme === o.id}
              onChange={() => setTheme(o.id)}
              className="sr-only"
            />
            {o.icon}
            {o.label}
          </label>
        ))}
      </fieldset>
    </Section>
  );
}

function AboutSection() {
  const sourceUrl = useSetupStatus().data?.sourceUrl;
  const version = useAbout().data?.version;
  return (
    <Section title="About">
      <p className="mb-2 text-sm text-muted">
        {version ? `Family Cloud ${version}. ` : ''}
        <Link
          to="/whats-new"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          What's new
        </Link>
      </p>
      <p className="text-sm text-muted">
        <Link to="/privacy" className="font-medium text-accent underline-offset-2 hover:underline">
          Privacy: what's kept about you and who can see your files
        </Link>
      </p>
      <p className="mt-2 text-sm text-muted">
        Family Cloud is free software under the GNU Affero General Public License v3.
        {sourceUrl && (
          <>
            {' '}
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Source code
            </a>
          </>
        )}
      </p>
    </Section>
  );
}

export function SettingsPage() {
  const { me } = useShell();
  const { hash } = useLocation();
  usePageTitle('Settings');
  // "/settings#security" (e.g. the admin two-factor banner): scroll there, also when already here.
  // getElementById, not querySelector: an arbitrary hash isn't necessarily a valid selector.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ProfileSection me={me} />
      <AppearanceSection />
      <PasskeysSection />
      <DevicesSection />
      <TwoFactorSection me={me} />
      <PasswordSection />
      <SessionsSection />
      <AboutSection />
    </div>
  );
}
