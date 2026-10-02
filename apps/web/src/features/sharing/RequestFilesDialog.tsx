import type { ShareLink } from '@familycloud/shared';
import { GiB, nameProblem, normalizeName } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { qk, useCreateFolder } from '../../api/queries';
import {
  Button,
  Dialog,
  PasswordField,
  SelectField,
  SwitchField,
  TextField,
  toast,
} from '../../components/ui';
import { copyTextLater } from '../../lib/clipboard';
import { LinkBox } from './LinkActions';

/** A request's title as a folder name: the characters a name can't hold become dashes. */
const folderName = (title: string) => normalizeName(title.replace(/[/\\]/g, '-'));

/**
 * One step from "I need files from someone" to a link to send them: makes a new folder for what
 * arrives and a file request into it. The sender sees an upload page and nothing else.
 */
export function RequestFilesDialog({
  parentId,
  onClose,
}: {
  /** Where the new folder goes: the folder being looked at. */
  parentId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createFolder = useCreateFolder();
  const [title, setTitle] = useState('');
  const [days, setDays] = useState('7');
  const [takeUpTo, setTakeUpTo] = useState(String(5 * GiB));
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ url: string; folder: string } | null>(null);

  const name = folderName(title);
  const problem = name ? nameProblem(name) : null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const work = (async () => {
      // A folder of that name may already be there: this request gets its own ("Name (2)").
      const folder = await createFolder.mutateAsync({ parentId, name, renameIfTaken: true });
      const link = await api<ShareLink>(`/nodes/${folder.id}/links`, {
        json: {
          kind: 'upload',
          title: title.trim(),
          allowDownload: false,
          maxUploadBytes: Number(takeUpTo),
          expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
          ...(usePassword && password ? { password } : {}),
        },
      });
      return { url: link.url ?? '', folder: folder.name };
    })();
    // Started during the tap: browsers only allow copying straight after one.
    const copied = copyTextLater(work.then((m) => m.url));
    try {
      setMade(await work);
      void qc.invalidateQueries({ queryKey: qk.sharedByMe });
      if (await copied) toast.success('Link copied');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Request files"
      size="md"
      footer={
        made ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      {made ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Send this link to the people you want files from. What they send lands in your new
            folder <strong>{made.folder}</strong>.
          </p>
          <LinkBox url={made.url} title={title.trim()} copyLabel="Copy request link" />
          <p className="text-sm text-muted">
            They can only add files. They can't see or download anything, and programs are refused.
            To stop it early, open the folder's menu → Request files and delete the link.
          </p>
        </div>
      ) : (
        <form onSubmit={create} className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Makes a new folder and a link. Anyone with the link can send files into that folder,
            without an account, and can't see what's in it.
          </p>
          <TextField
            label="What are you asking for?"
            placeholder="e.g. Photos from the wedding"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            error={problem ?? undefined}
            hint="Shown to the people you send the link to, and used as the folder's name."
            autoFocus
            required
          />
          <SelectField
            label="Stop taking files after"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </SelectField>
          <SelectField
            label="How much it takes"
            value={takeUpTo}
            onChange={(e) => setTakeUpTo(e.target.value)}
            hint="In total, from everyone with the link. Files count toward your storage."
          >
            <option value={String(GiB)}>Up to 1 GB</option>
            <option value={String(5 * GiB)}>Up to 5 GB</option>
            <option value={String(20 * GiB)}>Up to 20 GB</option>
          </SelectField>
          <SwitchField
            label="Require a password"
            description="Tell it to them separately, not in the same message as the link."
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
            icon={<Inbox size={16} />}
            loading={busy}
            disabled={!name || !!problem || (usePassword && password.length < 4)}
          >
            Create folder and link
          </Button>
        </form>
      )}
    </Dialog>
  );
}
