import type { ShareLink as ShareLinkDto, SharePermission } from '@familycloud/shared';
import { Check, Copy, Link2, Share, Trash2, Users } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import {
  useDirectory,
  useLinkMutations,
  useLinks,
  useShareMutations,
  useShares,
} from '../../api/queries';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PasswordField,
  QueryState,
  SelectField,
  Skeleton,
  SwitchField,
  Tabs,
  toast,
} from '../../components/ui';
import { copyText, copyTextLater } from '../../lib/clipboard';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';
import { canShareNatively, shareNatively } from '../../lib/share';

const onError = (err: unknown) => {
  toast.error(errorMessage(err));
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      icon={copied ? <Check className="text-success" /> : <Copy />}
      onClick={async () => {
        if (await copyText(text)) setCopied(true);
        else toast.error('Copy failed. Select the link and copy it manually.');
      }}
    />
  );
}

function ShareButton({ url, title }: { url: string; title: string }) {
  if (!canShareNatively()) return null;
  return (
    <IconButton
      label="Share…"
      icon={<Share />}
      onClick={async () => {
        if ((await shareNatively({ title, url })) === 'unavailable') {
          toast.error('Sharing is not available here. Copy the link instead.');
        }
      }}
    />
  );
}

/** "Expires in 6 days · Oct 5, 2:00 PM": how long is left, and exactly when. */
export function expiryLabel(expiresAt: string | null) {
  return expiresAt
    ? `Expires ${formatRelative(expiresAt)} · ${formatDateTime(expiresAt)}`
    : 'Never expires';
}

/** One public link with its settings, time left, and share/copy/delete actions. */
export function LinkRow({
  link: l,
  title,
  highlight = false,
  deleting,
  onDelete,
}: {
  link: ShareLinkDto;
  title: string;
  highlight?: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const soon = l.expiresAt && new Date(l.expiresAt).getTime() - Date.now() < 86_400_000;
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2',
        highlight ? 'border-accent bg-accent-soft' : 'border-border',
      )}
    >
      <div className="min-w-0 flex-1">
        {l.url ? (
          <p className="truncate font-mono text-xs select-all">{l.url}</p>
        ) : (
          <p className="text-xs text-muted">
            Address unavailable after a server key change. Delete and recreate it.
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge tone={soon ? 'danger' : l.expiresAt ? 'warning' : 'neutral'}>
            {expiryLabel(l.expiresAt)}
          </Badge>
          {l.hasPassword && <Badge>Password</Badge>}
          {!l.allowDownload && <Badge>View only</Badge>}
          {l.lastAccessedAt && (
            <Badge tone="accent">Opened {formatRelative(l.lastAccessedAt)}</Badge>
          )}
        </div>
      </div>
      {l.url && <ShareButton url={l.url} title={title} />}
      {l.url && <CopyButton text={l.url} label="Copy link" />}
      <IconButton label="Delete link" icon={<Trash2 />} disabled={deleting} onClick={onDelete} />
    </li>
  );
}

function FamilyTab({ nodeId }: { nodeId: string }) {
  const shares = useShares(nodeId);
  const directory = useDirectory();
  const m = useShareMutations(nodeId);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<SharePermission>('view');
  const sharedIds = new Set(shares.data?.items.map((s) => s.grantee.id));
  const available = directory.data?.items.filter((u) => !sharedIds.has(u.id)) ?? [];

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    try {
      await m.add.mutateAsync({ userId, permission });
      setUserId('');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SelectField
          label="Family member"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          containerClassName="flex-1"
        >
          <option value="">{available.length ? 'Choose someone…' : 'Everyone has access'}</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} ({u.email})
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Access"
          value={permission}
          onChange={(e) => setPermission(e.target.value as SharePermission)}
          containerClassName="sm:w-36"
        >
          <option value="view">Can view</option>
          <option value="edit">Can edit</option>
        </SelectField>
        <Button type="submit" variant="primary" disabled={!userId} loading={m.add.isPending}>
          Share
        </Button>
      </form>
      <QueryState
        query={shares}
        loading={<Skeleton className="h-16" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Users />}
            title="Only you have access"
            description="Share with family members to let them see or edit this."
            className="py-6"
          />
        }
      >
        {(d) => (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {d.items.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={s.grantee.displayName} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.grantee.displayName}</p>
                  <p className="truncate text-xs text-muted">{s.grantee.email}</p>
                </div>
                <SelectField
                  label={`Access for ${s.grantee.displayName}`}
                  hideLabel
                  value={s.permission}
                  onChange={(e) =>
                    m.update.mutate(
                      { id: s.id, permission: e.target.value as SharePermission },
                      { onError },
                    )
                  }
                  className="h-9 w-28"
                >
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </SelectField>
                <IconButton
                  label={`Stop sharing with ${s.grantee.displayName}`}
                  icon={<Trash2 />}
                  disabled={m.remove.isPending && m.remove.variables === s.id}
                  onClick={() => m.remove.mutate(s.id, { onError })}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <p className="text-xs text-muted">
        People with edit access can add files; the space they use counts against your storage.
      </p>
    </div>
  );
}

const EXPIRY = [
  { value: '', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

function LinkTab({ nodeId, name }: { nodeId: string; name: string }) {
  const links = useLinks(nodeId);
  const [fresh, setFresh] = useState<string | null>(null);
  const m = useLinkMutations(nodeId);
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [days, setDays] = useState('7');
  const [allowDownload, setAllowDownload] = useState(true);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = m.create.mutateAsync({
      allowDownload,
      ...(usePassword && password ? { password } : {}),
      expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null,
    });
    // Started during the tap: browsers only allow copying (and sharing) straight after one.
    const copied = copyTextLater(created.then((l) => l.url));
    try {
      const link = await created;
      setPassword('');
      setFresh(link.id);
      const didCopy = await copied;
      if (link.url && canShareNatively()) {
        const outcome = await shareNatively({ title: name, url: link.url });
        if (outcome !== 'unavailable') return;
      }
      toast.success(didCopy ? 'Link created and copied' : 'Link created');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={create} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <p className="text-sm text-muted">
          Anyone with the link can open it, even without an account.
        </p>
        <SelectField label="Link expires" value={days} onChange={(e) => setDays(e.target.value)}>
          {EXPIRY.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <SwitchField
          label="Allow downloads"
          description="Turn off to allow viewing only."
          checked={allowDownload}
          onCheckedChange={setAllowDownload}
        />
        <SwitchField
          label="Require a password"
          checked={usePassword}
          onCheckedChange={setUsePassword}
        />
        {usePassword && (
          <PasswordField
            label="Link password"
            value={password}
            minLength={4}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        )}
        <Button
          type="submit"
          variant="primary"
          icon={<Link2 size={16} />}
          loading={m.create.isPending}
          disabled={usePassword && password.length < 4}
        >
          Create link
        </Button>
      </form>
      <QueryState
        query={links}
        loading={<Skeleton className="h-16" />}
        isEmpty={(d) => d.items.length === 0}
        empty={null}
      >
        {(d) => (
          <ul className="flex flex-col gap-2">
            {d.items.map((l) => (
              <LinkRow
                key={l.id}
                link={l}
                title={name}
                highlight={l.id === fresh}
                deleting={m.revoke.isPending && m.revoke.variables === l.id}
                onDelete={() => m.revoke.mutate(l.id, { onError })}
              />
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

export function ShareDialog({
  node,
  onClose,
}: {
  node: { id: string; name: string };
  onClose: () => void;
}) {
  const [tab, setTab] = useState('family');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Share “${node.name}”`} size="md">
      <Tabs
        label="Sharing options"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'family', label: 'Family', content: <FamilyTab nodeId={node.id} /> },
          {
            value: 'link',
            label: 'Public link',
            content: <LinkTab nodeId={node.id} name={node.name} />,
          },
        ]}
      />
    </Dialog>
  );
}
