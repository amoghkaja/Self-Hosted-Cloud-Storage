import type { CreateAppPasswordResponse, Me } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  HardDrive,
  KeyRound,
  Laptop,
  Monitor,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { qk, useAppPasswordMutations, useAppPasswords, useSessions } from '../../api/queries';
import { useShell } from '../../app/guards';
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
  UsageBar,
} from '../../components/ui';
import { describeUserAgent, formatRelative } from '../../lib/format';

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
  return (
    <section
      id={id}
      aria-labelledby={`${id ?? title}-h`}
      className="rounded-2xl border border-border bg-surface p-5"
    >
      <h2 id={`${id ?? title}-h`} className="text-base font-semibold">
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
        <UsageBar used={me.usedBytes} total={me.quotaBytes} label="Your storage use" />
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', { json: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      toast.success('Password changed. Other devices were signed out.');
    } catch (err) {
      setError(errorMessage(err));
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
          required
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint="At least 10 characters."
          minLength={10}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={error}
          required
        />
        <Button type="submit" loading={busy} className="self-start">
          Change password
        </Button>
      </form>
    </Section>
  );
}

function TwoFactorSection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const res = await api<{ secret: string; otpauthUrl: string }>('/auth/totp/setup', {
        json: {},
      });
      setSetup({
        secret: res.secret,
        qr: await QRCode.toDataURL(res.otpauthUrl, { margin: 1, width: 200 }),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(qk.me, await api<Me>('/auth/totp/enable', { json: { code } }));
      setSetup(null);
      setCode('');
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
      qc.setQueryData(qk.me, await api<Me>('/auth/totp/disable', { json: { password, code } }));
      setCode('');
      setPassword('');
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
      {me.totpEnabled ? (
        <form onSubmit={disable} className="flex max-w-md flex-col gap-3">
          <Badge tone="success" className="self-start">
            <ShieldCheck size={12} aria-hidden /> On
          </Badge>
          <PasswordField
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <TextField
            label="Current code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
          <Button type="submit" variant="danger" loading={busy} className="self-start">
            Turn off
          </Button>
        </form>
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
            <code className="rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-sm break-all">
              {setup.secret}
            </code>
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
        <Button variant="primary" icon={<ShieldCheck size={16} />} onClick={start} loading={busy}>
          Set up two-factor
        </Button>
      )}
    </Section>
  );
}

function ConnectGuide({ creds }: { creds: CreateAppPasswordResponse }) {
  const [tab, setTab] = useState('iphone');
  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">{value}</code>
      <Button
        size="sm"
        onClick={() =>
          navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied`))
        }
      >
        Copy
      </Button>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Row label="Server" value={creds.davUrl} />
        <Row label="Username" value={creds.username} />
        <Row label="Password" value={creds.password} />
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
            value: 'iphone',
            label: 'iPhone / iPad',
            content: (
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>
                  The Files app can't connect to WebDAV on its own, so install a free helper app
                  that adds itself to Files, such as <strong>Owlfiles</strong> or{' '}
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
                  Away from home, single files over 100 MB can't upload this way. Use the website's
                  Upload button for long videos.
                </li>
              </ol>
            ),
          },
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
                  Choose <strong>Registered User</strong> and enter the username and password above.
                </li>
              </ol>
            ),
          },
          {
            value: 'windows',
            label: 'Windows',
            content: (
              <ol className="list-decimal space-y-2 pl-5 text-sm">
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
              </ol>
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
  const [creds, setCreds] = useState<CreateAppPasswordResponse | null>(null);
  const [remove, setRemove] = useState<{ id: string; name: string } | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setCreds(await m.create.mutateAsync(name.trim()));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const close = () => {
    setOpen(false);
    setCreds(null);
    setName('');
  };

  return (
    <Section
      id="devices"
      title="Network drive"
      description="Open your files in the iPhone/iPad Files app, Finder or Windows Explorer. Each device gets its own password you can remove if it's lost."
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
            <Button
              type="submit"
              variant="primary"
              loading={m.create.isPending}
              disabled={!name.trim()}
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
        onConfirm={() => m.revoke.mutateAsync(remove!.id)}
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

export function SettingsPage() {
  const { me } = useShell();
  useEffect(() => {
    document.title = 'Settings · Family Cloud';
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  }, []);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ProfileSection me={me} />
      <DevicesSection />
      <TwoFactorSection me={me} />
      <PasswordSection />
      <SessionsSection />
    </div>
  );
}
