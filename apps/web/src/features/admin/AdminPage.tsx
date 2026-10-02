import {
  type AdminUser,
  emailAllowed,
  formatBytes,
  GiB,
  percent,
  type Settings,
  type Volume,
} from '@familycloud/shared';
import {
  CircleAlert,
  EllipsisVertical,
  HardDrive,
  PieChart,
  Plus,
  ScrollText,
  TriangleAlert,
  UserPlus,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import {
  useAdminInvites,
  useAdminMutations,
  useAdminOverview,
  useAudit,
  useVolumeCandidates,
} from '../../api/queries';
import { useShell } from '../../app/guards';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  EmptyState,
  formatQuota,
  IconButton,
  Progress,
  QueryState,
  SelectField,
  Skeleton,
  Tabs,
  TextField,
  toast,
  UsageBar,
} from '../../components/ui';
import { formatDate, formatDateTime, formatRelative } from '../../lib/format';
import { usePageTitle } from '../../lib/usePageTitle';
import { LinkBox } from '../sharing/LinkActions';
import { BrandingCard } from './BrandingCard';
import { ByteSizeInput } from './ByteSizeInput';
import { AllocateDialog, DiskBreakdown, FamilyBreakdown } from './StorageOverview';

/** Runs a fire-and-forget admin action, confirming success and surfacing failures. */
function run(p: Promise<unknown>, success?: string) {
  p.then(
    () => success && toast.success(success),
    (err) => toast.error(errorMessage(err)),
  );
}

function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function Overview() {
  const q = useAdminOverview();
  const m = useAdminMutations();
  const [, setParams] = useSearchParams();
  const [allocating, setAllocating] = useState(false);
  return (
    <QueryState query={q} loading={<Skeleton className="h-64" />}>
      {(d) => {
        const t = d.totals;
        const familyFree = Math.max(0, t.familyCapacityBytes - t.usedBytes - t.reservedBytes);
        const capped = d.settings.globalCapacityBytes !== null;
        return (
          <div className="flex flex-col gap-4">
            {d.warnings.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label="Warnings">
                {d.warnings.map((w) => (
                  <li
                    key={w}
                    className="flex gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                  >
                    <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label="Used by family"
                value={formatBytes(t.usedBytes)}
                sub={t.reservedBytes ? `+${formatBytes(t.reservedBytes)} uploading` : undefined}
              />
              <Stat
                label="Family space left"
                value={formatBytes(familyFree)}
                sub={`of ${formatBytes(t.familyCapacityBytes)} for the family`}
              />
              <Stat
                label="Given to people"
                value={formatBytes(t.allocatedQuotaBytes)}
                sub={
                  t.unlimitedUsers
                    ? `${t.unlimitedUsers} ${t.unlimitedUsers === 1 ? 'person has' : 'people have'} no personal limit`
                    : 'Everyone has an allowance'
                }
              />
            </div>
            <Card
              title="Family storage"
              action={
                <Button
                  variant="primary"
                  icon={<PieChart size={16} />}
                  onClick={() => setAllocating(true)}
                >
                  Allocate space
                </Button>
              }
            >
              <p className="mb-4 text-sm text-muted">
                {capped
                  ? `The family may use up to ${formatBytes(d.settings.globalCapacityBytes ?? 0)} in total${
                      t.familyCapacityBytes < (d.settings.globalCapacityBytes ?? 0)
                        ? `, but the disks only have room for ${formatBytes(t.familyCapacityBytes)}`
                        : ''
                    }.`
                  : `The family can use all the space the disks allow: ${formatBytes(t.familyCapacityBytes)}.`}
              </p>
              <FamilyBreakdown d={d} />
              <div className="mt-4 flex flex-wrap gap-2">
                {capped && (
                  <Button
                    size="sm"
                    loading={m.updateSettings.isPending}
                    onClick={() =>
                      run(
                        m.updateSettings.mutateAsync({ globalCapacityBytes: null }),
                        'The family can now use all available space',
                      )
                    }
                  >
                    Give the family all available space
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setParams({ tab: 'settings' }, { replace: true })}
                >
                  {capped ? 'Change the family limit' : 'Set a family limit'}
                </Button>
              </div>
            </Card>
            <Card title="This computer’s disks">
              <p className="mb-4 text-sm text-muted">
                {formatBytes(t.diskTotalBytes)} in total. Only the green part can take new family
                files.
              </p>
              <DiskBreakdown d={d} />
              <Button
                size="sm"
                variant="ghost"
                className="mt-4"
                onClick={() => setParams({ tab: 'storage' }, { replace: true })}
              >
                Manage disks and limits
              </Button>
            </Card>
            <p className="text-center text-xs text-muted">
              Family Cloud {d.version} ·{' '}
              <Link to="/whats-new" className="underline underline-offset-2 hover:text-text">
                What's new
              </Link>
            </p>
            {allocating && <AllocateDialog d={d} onClose={() => setAllocating(false)} />}
          </div>
        );
      }}
    </QueryState>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

function EditUserDialog({
  user,
  onClose,
  selfId,
}: {
  user: AdminUser;
  onClose: () => void;
  selfId: string;
}) {
  const m = useAdminMutations();
  const [quota, setQuota] = useState<number | null>(user.quotaBytes);
  const [role, setRole] = useState(user.role);
  const save = async () => {
    try {
      await m.updateUser.mutateAsync({ id: user.id, quotaBytes: quota, role });
      toast.success(`Updated ${user.displayName}`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${user.displayName}`}
      description={`Currently using ${formatBytes(user.usedBytes)}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={m.updateUser.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ByteSizeInput
          label="Storage quota"
          value={quota}
          onChange={setQuota}
          unlimitedLabel="Unlimited"
          hint={
            quota !== null && quota < user.usedBytes
              ? 'Below current usage: they keep their files but can’t upload until they free up space.'
              : 'You can raise or lower this any time.'
          }
        />
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser['role'])}
          disabled={user.id === selfId}
        >
          <option value="member">Member</option>
          <option value="admin">Admin (can manage people and storage)</option>
        </SelectField>
      </div>
    </Dialog>
  );
}

function InviteDialog({
  onClose,
  defaultQuota,
}: {
  onClose: () => void;
  defaultQuota: number | null;
}) {
  const m = useAdminMutations();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [quota, setQuota] = useState<number | null>(defaultQuota);
  const [url, setUrl] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await m.createInvite.mutateAsync({
        email: email.trim() || null,
        role,
        quotaBytes: quota,
        expiresInDays: 7,
      });
      setUrl(res.url);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite a family member"
      size="md"
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      {url ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Send this link to them (text or email). It works once and expires in 7 days.
          </p>
          <LinkBox url={url} title="Join our family cloud" copyLabel="Copy invite link" />
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <TextField
            label="Email (optional)"
            type="email"
            hint="If set, only this email can use the invite."
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <SelectField
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </SelectField>
          <ByteSizeInput
            label="Storage quota"
            value={quota}
            onChange={setQuota}
            unlimitedLabel="Unlimited"
          />
          <Button
            type="submit"
            variant="primary"
            loading={m.createInvite.isPending}
            className="self-start"
          >
            Create invite link
          </Button>
        </form>
      )}
    </Dialog>
  );
}

/** Makes a one-time link for someone who forgot their password, for the admin to send them. */
function PasswordResetDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const m = useAdminMutations();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const create = async () => {
    try {
      setLink(await m.createPasswordReset.mutateAsync(user.id));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reset ${user.displayName}'s password`}
      size="md"
      footer={
        link ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={m.createPasswordReset.isPending} onClick={create}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Send this link to {user.displayName} (text or email). It works once, until{' '}
            {formatDateTime(link.expiresAt)}.
          </p>
          <LinkBox url={link.url} title="Choose a new password" copyLabel="Copy reset link" />
          <p className="text-xs text-muted">
            Only send it to them: whoever opens it can choose the password.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            For when {user.displayName} forgot their password. You get a link to send them, and they
            choose a new password themselves (you never see it).
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>They're signed out everywhere once they use it.</li>
            <li>
              {user.totpEnabled
                ? 'Their two-factor sign-in stays on: they still need their code.'
                : 'Any older reset link for them stops working.'}
            </li>
            <li>Network drive passwords on their devices keep working.</li>
          </ul>
        </div>
      )}
    </Dialog>
  );
}

/** Deleting an account for good: shows what goes, and asks for the email to be typed. */
function DeleteUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const m = useAdminMutations();
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === user.email;
  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    try {
      await m.deleteUser.mutateAsync({ id: user.id, confirmEmail: typed });
      toast.success(`${user.displayName}'s account was deleted`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${user.displayName}'s account?`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="delete-user"
            variant="danger"
            loading={m.deleteUser.isPending}
            disabled={!matches}
          >
            Delete forever
          </Button>
        </>
      }
    >
      <form id="delete-user" onSubmit={remove} className="flex flex-col gap-3 text-sm">
        <p>This can't be undone. Gone for good:</p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>
            Everything in their files ({formatBytes(user.usedBytes)}), including their trash and
            older versions
          </li>
          <li>What they shared with others, and their public links</li>
          <li>Photos they added to family albums</li>
        </ul>
        <p>Files they added to other people's folders stay with those people.</p>
        <TextField
          label={`Type ${user.email} to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </form>
    </Dialog>
  );
}

function People() {
  const { me } = useShell();
  const q = useAdminOverview();
  const invites = useAdminInvites();
  const m = useAdminMutations();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    label: string;
    run: () => Promise<unknown>;
  } | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="People"
        action={
          <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInviting(true)}>
            Invite
          </Button>
        }
      >
        <QueryState query={q} loading={<Skeleton className="h-40" />}>
          {(d) => (
            <ul className="divide-y divide-border">
              {d.users.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-3">
                  <Avatar name={u.displayName} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{u.displayName}</span>
                      {u.role === 'admin' && <Badge tone="accent">Admin</Badge>}
                      {u.disabled && <Badge tone="danger">Disabled</Badge>}
                      {u.totpEnabled && <Badge tone="success">2FA</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted">{u.email}</p>
                    <p className="truncate text-xs text-muted">
                      {formatBytes(u.usedBytes)} of {formatQuota(u.quotaBytes)}
                      {u.lastSeenAt ? ` · active ${formatRelative(u.lastSeenAt)}` : ''}
                    </p>
                    <div className="mt-1.5 max-w-xs">
                      <Progress
                        value={u.quotaBytes ? Math.min(u.usedBytes, u.quotaBytes) : 0}
                        max={u.quotaBytes ?? 1}
                        label={`${u.displayName} storage`}
                        tone={percent(u.usedBytes, u.quotaBytes) >= 95 ? 'danger' : 'accent'}
                      />
                    </div>
                  </div>
                  <Button size="sm" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                  {u.id !== me.id && (
                    <DropdownMenu
                      label={`More for ${u.displayName}`}
                      trigger={
                        <IconButton
                          label={`More actions for ${u.displayName}`}
                          icon={<EllipsisVertical />}
                          noTooltip
                        />
                      }
                      actions={[
                        {
                          id: 'disable',
                          label: u.disabled ? 'Enable account' : 'Disable account',
                          tone: u.disabled ? 'default' : 'danger',
                          onSelect: () =>
                            setConfirm({
                              title: u.disabled
                                ? `Enable ${u.displayName}?`
                                : `Disable ${u.displayName}?`,
                              description: u.disabled
                                ? 'They can sign in again.'
                                : 'They are signed out everywhere, cannot sign in, and their public links stop working. Their files are kept.',
                              label: u.disabled ? 'Enable' : 'Disable',
                              run: () =>
                                m.updateUser.mutateAsync({ id: u.id, disabled: !u.disabled }),
                            }),
                        },
                        ...(u.disabled
                          ? []
                          : [
                              {
                                id: 'password',
                                label: 'Password reset link…',
                                onSelect: () => setResetting(u),
                              },
                            ]),
                        {
                          id: 'signout',
                          label: 'Sign out everywhere',
                          onSelect: () => run(m.signOut.mutateAsync(u.id), 'Signed out'),
                        },
                        ...(u.totpEnabled
                          ? [
                              {
                                id: 'totp',
                                label: 'Reset two-factor',
                                onSelect: () =>
                                  run(m.resetTotp.mutateAsync(u.id), 'Two-factor reset'),
                              },
                            ]
                          : []),
                        // Only once disabled: deleting is a second, deliberate step.
                        ...(u.disabled
                          ? [
                              {
                                id: 'delete',
                                label: 'Delete account…',
                                tone: 'danger' as const,
                                separatorBefore: true,
                                onSelect: () => setRemoving(u),
                              },
                            ]
                          : []),
                      ]}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <Card title="Pending invites">
        <QueryState
          query={invites}
          loading={<Skeleton className="h-12" />}
          isEmpty={(d) => d.items.length === 0}
          empty={<p className="text-sm text-muted">No pending invites.</p>}
        >
          {(d) => (
            <ul className="divide-y divide-border">
              {d.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.email ?? 'Anyone with the link'}</p>
                    <p className="text-xs text-muted">
                      {i.role}, {formatQuota(i.quotaBytes)} · expires {formatDate(i.expiresAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    loading={m.revokeInvite.isPending && m.revokeInvite.variables === i.id}
                    onClick={() => run(m.revokeInvite.mutateAsync(i.id), 'Invite revoked')}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      {editing && <EditUserDialog user={editing} selfId={me.id} onClose={() => setEditing(null)} />}
      {resetting && <PasswordResetDialog user={resetting} onClose={() => setResetting(null)} />}
      {removing && <DeleteUserDialog user={removing} onClose={() => setRemoving(null)} />}
      {inviting && (
        <InviteDialog
          defaultQuota={q.data?.settings.defaultQuotaBytes ?? 50 * GiB}
          onClose={() => setInviting(false)}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.label ?? 'OK'}
        tone="danger"
        onConfirm={async () => {
          try {
            await confirm!.run();
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </div>
  );
}

// ── Storage ─────────────────────────────────────────────────────────────────

function VolumeCard({ v, onEdit }: { v: Volume; onEdit: () => void }) {
  const m = useAdminMutations();
  const [drainOpen, setDrainOpen] = useState(false);
  const tone = {
    active: 'success',
    draining: 'warning',
    readonly: 'neutral',
    retired: 'neutral',
  } as const;
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive size={18} className="text-muted" aria-hidden />
        <p className="font-medium">{v.name}</p>
        <Badge tone={v.online ? tone[v.status] : 'danger'}>{v.online ? v.status : 'offline'}</Badge>
        <code className="ml-auto truncate text-xs text-muted">{v.path}</code>
      </div>
      {v.disk && v.usable && (
        <div className="mt-3">
          <UsageBar
            used={v.usedByAppBytes}
            total={v.usable.totalBytes}
            label={`Family space on ${v.name}`}
            showText={false}
          />
          <p className="mt-1.5 text-xs text-muted tabular-nums">
            Family files {formatBytes(v.usedByAppBytes)} ({v.blobCount} files) ·{' '}
            {formatBytes(v.usable.freeBytes)} free for the family
            {v.capacityLimitBytes !== null && ` (limit ${formatBytes(v.capacityLimitBytes)})`}
          </p>
          <p className="text-xs text-muted tabular-nums">
            Whole disk: {formatBytes(v.disk.freeBytes)} free of {formatBytes(v.disk.totalBytes)}
            {v.reserveBytes > 0 && `, ${formatBytes(v.reserveBytes)} always kept free`}
          </p>
        </div>
      )}
      {v.statusMessage && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <CircleAlert size={14} aria-hidden /> {v.statusMessage}
        </p>
      )}
      {v.status !== 'retired' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={onEdit}>
            Limits
          </Button>
          {v.status === 'active' && (
            <Button
              size="sm"
              loading={m.updateVolume.isPending}
              onClick={() => run(m.updateVolume.mutateAsync({ id: v.id, status: 'readonly' }))}
            >
              Pause new files
            </Button>
          )}
          {v.status === 'readonly' && (
            <Button
              size="sm"
              loading={m.updateVolume.isPending}
              onClick={() => run(m.updateVolume.mutateAsync({ id: v.id, status: 'active' }))}
            >
              Accept new files
            </Button>
          )}
          {v.status === 'draining' ? (
            <Button
              size="sm"
              loading={m.cancelDrain.isPending}
              onClick={() => run(m.cancelDrain.mutateAsync(v.id))}
            >
              Stop moving
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setDrainOpen(true)}>
              Move files off & retire
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={drainOpen}
        onOpenChange={setDrainOpen}
        tone="danger"
        title={`Move everything off “${v.name}”?`}
        description="Every file is copied to your other disks and checked before being removed from this one. Everything stays available meanwhile. When it's done the disk is retired and safe to unplug."
        confirmLabel="Start moving files"
        onConfirm={async () => {
          try {
            await m.drain.mutateAsync(v.id);
            toast.success('Moving files. Progress shows on this page.');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </li>
  );
}

function AddVolumeDialog({ onClose }: { onClose: () => void }) {
  const cands = useVolumeCandidates(true);
  const m = useAdminMutations();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const pick = cands.data?.items.find((c) => c.path === path);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await m.addVolume.mutateAsync({ name: name || pick?.name || 'disk', path });
      toast.success('Disk added. New files can go there now.');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add a disk" size="md">
      <div className="flex flex-col gap-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Plug in the disk and mount it on the server under <code>/srv/familycloud/</code> (e.g.{' '}
            <code>/srv/familycloud/disk2</code>). The <code>scripts/add-disk.sh</code> helper walks
            you through it.
          </li>
          <li>It then shows up below. No restart needed.</li>
        </ol>
        <QueryState
          query={cands}
          loading={<Skeleton className="h-16" />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              icon={<HardDrive />}
              title="No new disks found"
              description={`Nothing new under ${cands.data?.root ?? 'the volumes folder'} yet.`}
              className="py-6"
            />
          }
        >
          {(d) => (
            <form onSubmit={add} className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">Choose a folder</legend>
                {d.items.map((c) => (
                  <label
                    key={c.path}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                  >
                    <input
                      type="radio"
                      name="volume"
                      value={c.path}
                      checked={path === c.path}
                      onChange={() => setPath(c.path)}
                      className="mt-1 accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{c.name}</span>
                      <span className="block text-xs text-muted">
                        {formatBytes(c.freeBytes)} free of {formatBytes(c.totalBytes)}
                      </span>
                      {c.sameFilesystemAs && (
                        <span className="mt-1 block text-xs text-warning">
                          Same disk as “{c.sameFilesystemAs}”: adds no extra space. Did you forget
                          to mount the new disk?
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>
              <TextField
                label="Name"
                placeholder={pick?.name ?? 'disk2'}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!path}
                loading={m.addVolume.isPending}
                className="self-start"
              >
                Add disk
              </Button>
            </form>
          )}
        </QueryState>
      </div>
    </Dialog>
  );
}

function VolumeLimitsDialog({ v, onClose }: { v: Volume; onClose: () => void }) {
  const m = useAdminMutations();
  const [limit, setLimit] = useState<number | null>(v.capacityLimitBytes);
  const [reserve, setReserve] = useState<number | null>(v.reserveBytes);
  const save = async () => {
    try {
      await m.updateVolume.mutateAsync({
        id: v.id,
        capacityLimitBytes: limit,
        reserveBytes: reserve ?? 0,
      });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Limits for ${v.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={m.updateVolume.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ByteSizeInput
          label="Maximum family files on this disk"
          value={limit}
          onChange={setLimit}
          unlimitedLabel="Use the whole disk"
          hint="Handy when the disk is shared with other things (like this PC's own files)."
        />
        <ByteSizeInput
          label="Always keep free"
          value={reserve}
          onChange={setReserve}
          hint="Space left untouched so the computer never runs completely out of room."
        />
      </div>
    </Dialog>
  );
}

function Storage() {
  const q = useAdminOverview();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Volume | null>(null);
  return (
    <Card
      title="Disks"
      action={
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Add disk
        </Button>
      }
    >
      <QueryState query={q} loading={<Skeleton className="h-40" />}>
        {(d) => (
          <ul className="flex flex-col gap-3">
            {d.volumes.map((v) => (
              <VolumeCard key={v.id} v={v} onEdit={() => setEditing(v)} />
            ))}
          </ul>
        )}
      </QueryState>
      {adding && <AddVolumeDialog onClose={() => setAdding(false)} />}
      {editing && <VolumeLimitsDialog v={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

/** "smithfamily.com, @example.org" → ["smithfamily.com", "example.org"] */
const parseDomains = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  ),
];

function SettingsForm({
  initial,
  usable,
  people,
}: {
  initial: Settings;
  usable: number;
  people: AdminUser[];
}) {
  const m = useAdminMutations();
  const { me } = useShell();
  const [s, setS] = useState(initial);
  const [domainsText, setDomainsText] = useState(initial.allowedEmailDomains.join(', '));
  const domains = parseDomains(domainsText);
  const lockedOut = people.filter((u) => !u.disabled && !emailAllowed(domains, u.email));
  const selfLockout = !emailAllowed(domains, me.email);
  // Raw text, so the field can be cleared and retyped (a number state would snap back to 1).
  const [retention, setRetention] = useState(String(initial.trashRetentionDays));
  const retentionDays = Number(retention);
  const retentionError =
    Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 365
      ? null
      : 'Enter a whole number of days from 1 to 365.';
  const [versions, setVersions] = useState(String(initial.versionRetentionDays));
  const versionDays = Number(versions);
  const versionsError =
    versions !== '' && Number.isInteger(versionDays) && versionDays >= 0 && versionDays <= 365
      ? null
      : 'Enter a whole number of days from 0 to 365.';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (retentionError || versionsError || selfLockout) return;
    try {
      await m.updateSettings.mutateAsync({
        ...s,
        trashRetentionDays: retentionDays,
        versionRetentionDays: versionDays,
        allowedEmailDomains: domains,
      });
      toast.success('Settings saved');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <form onSubmit={save} className="flex max-w-lg flex-col gap-6">
      <ByteSizeInput
        label="Family storage limit"
        value={s.globalCapacityBytes}
        onChange={(v) => setS({ ...s, globalCapacityBytes: v })}
        unlimitedLabel="Only limited by the disks"
        hint={`Caps everyone combined. The disks have room for ${formatBytes(usable)}; with no limit the family can use all of it.`}
      />
      <ByteSizeInput
        label="Default quota for new invites"
        value={s.defaultQuotaBytes}
        onChange={(v) => setS({ ...s, defaultQuotaBytes: v })}
        unlimitedLabel="Unlimited"
      />
      <ByteSizeInput
        label="Largest single file"
        value={s.maxFileSizeBytes}
        onChange={(v) => setS({ ...s, maxFileSizeBytes: v })}
        unlimitedLabel="No limit"
      />
      <TextField
        label="Keep deleted items in trash for (days)"
        type="number"
        min={1}
        max={365}
        step={1}
        value={retention}
        onChange={(e) => setRetention(e.target.value)}
        error={retention === '' ? null : retentionError}
        required
      />
      <TextField
        label="Keep older versions of files for (days)"
        type="number"
        min={0}
        max={365}
        step={1}
        value={versions}
        onChange={(e) => setVersions(e.target.value)}
        error={versions === '' ? null : versionsError}
        hint={
          versionDays === 0
            ? 'Off: saving over a file replaces it for good.'
            : `When a file is saved over (from the network drive, or "Replace" on upload), what it held is kept this long so it can be restored. Up to 50 per file; they count toward the owner's storage and make way automatically when the owner runs out of space.`
        }
        required
      />
      <div className="flex flex-col gap-2">
        <TextField
          label="Only allow these email domains"
          value={domainsText}
          onChange={(e) => setDomainsText(e.target.value)}
          placeholder="e.g. smithfamily.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          error={
            selfLockout
              ? `Your own address (${me.email}) isn't covered, so you'd be locked out.`
              : null
          }
          hint={
            domains.length
              ? `Only @${domains.join(', @')} addresses can be invited or sign in (web, passkeys and the network drive).`
              : 'Empty: any address can be invited. Add your family domain to allow only those.'
          }
        />
        {lockedOut.length > 0 && !selfLockout && (
          <p
            role="status"
            className="flex gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {lockedOut.map((u) => `${u.displayName} (${u.email})`).join(', ')}{' '}
              {lockedOut.length === 1 ? 'is' : 'are'} outside these domains and will be signed out
              when you save.
            </span>
          </p>
        )}
      </div>
      <Button
        type="submit"
        variant="primary"
        loading={m.updateSettings.isPending}
        disabled={selfLockout}
        className="self-start"
      >
        Save settings
      </Button>
    </form>
  );
}

function AppSettings() {
  const q = useAdminOverview();
  return (
    <div className="flex flex-col gap-4">
      <Card title="Settings">
        <QueryState query={q} loading={<Skeleton className="h-64" />}>
          {(d) => (
            <SettingsForm
              initial={d.settings}
              usable={d.totals.usableTotalBytes}
              people={d.users}
            />
          )}
        </QueryState>
      </Card>
      <BrandingCard />
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function Activity() {
  const q = useAudit();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Activity">
      <QueryState
        query={q}
        loading={<Skeleton className="h-64" />}
        isEmpty={() => items.length === 0}
        empty={<EmptyState icon={<ScrollText />} title="No activity yet" />}
      >
        {() => (
          <>
            <ul className="divide-y divide-border text-sm">
              {items.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5 py-2">
                  <span className="w-40 shrink-0 text-xs text-muted tabular-nums">
                    {formatDateTime(e.createdAt)}
                  </span>
                  <span className="font-medium">{e.actor?.displayName ?? 'System'}</span>
                  <code className="text-xs text-muted">{e.action}</code>
                  {e.ip && <span className="text-xs text-muted">{e.ip}</span>}
                </li>
              ))}
            </ul>
            {q.hasNextPage && (
              <Button
                className="mt-3"
                onClick={() => void q.fetchNextPage()}
                loading={q.isFetchingNextPage}
              >
                Load more
              </Button>
            )}
          </>
        )}
      </QueryState>
    </Card>
  );
}

const TABS = ['overview', 'people', 'storage', 'settings', 'activity'] as const;

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab') as (typeof TABS)[number])
    ? (params.get('tab') as string)
    : 'overview';
  usePageTitle('Admin');
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      <Tabs
        label="Admin sections"
        sticky
        value={tab}
        onValueChange={(v) => setParams({ tab: v }, { replace: true })}
        items={[
          { value: 'overview', label: 'Overview', content: <Overview /> },
          { value: 'people', label: 'People', content: <People /> },
          { value: 'storage', label: 'Storage', content: <Storage /> },
          { value: 'settings', label: 'Settings', content: <AppSettings /> },
          { value: 'activity', label: 'Activity', content: <Activity /> },
        ]}
      />
    </div>
  );
}
