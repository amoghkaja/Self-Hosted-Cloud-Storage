import { Button, Dialog } from '../../components/ui';

/**
 * "These already exist here": replace them (their current contents are kept as a version, so
 * it's undoable) or keep both (the new ones get "name (1)"). Like Google Drive asks.
 */
export function ReplaceDialog({
  names,
  folderName,
  retentionDays,
  onChoose,
  onCancel,
}: {
  names: string[];
  folderName: string;
  retentionDays: number;
  onChoose: (replace: boolean) => void;
  onCancel: () => void;
}) {
  const one = names.length === 1;
  const shown = names.slice(0, 5);
  const keepsVersions = retentionDays > 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      title={one ? `“${names[0]}” is already here` : `${names.length} files are already here`}
      description={`In ${folderName}. What should happen to ${one ? 'it' : 'them'}?`}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={keepsVersions ? 'secondary' : 'primary'} onClick={() => onChoose(false)}>
            Keep both
          </Button>
          <Button variant={keepsVersions ? 'primary' : 'danger'} onClick={() => onChoose(true)}>
            Replace
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {!one && (
          <ul className="list-disc space-y-0.5 pl-5 text-muted">
            {shown.map((n) => (
              <li key={n} className="truncate">
                {n}
              </li>
            ))}
            {names.length > shown.length && <li>and {names.length - shown.length} more</li>}
          </ul>
        )}
        <p>
          <strong>Replace</strong>{' '}
          {keepsVersions
            ? `saves the new ${one ? 'file' : 'files'} in place. What's there now stays in Version history for ${retentionDays} days.`
            : `deletes what's there now for good (your admin has turned versions off).`}
        </p>
        <p>
          <strong>Keep both</strong> adds the new {one ? 'one' : 'ones'} with a number, like “name
          (1)”.
        </p>
      </div>
    </Dialog>
  );
}
