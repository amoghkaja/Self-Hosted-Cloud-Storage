import { type FormEvent, useState } from 'react';
import { errorMessage, isWrongPassword } from '../../api/client';
import { Button, Dialog, PasswordField, toast } from '../../components/ui';

/**
 * "Confirm it's you", before anything that hands out a new way into the account (a passkey, a
 * two-factor app). `onConfirm` gets the password: a wrong one is shown on the field and the
 * dialog stays open; any other failure closes it with a message.
 */
export function ConfirmPasswordDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPassword('');
    setError(null);
    onOpenChange(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
      close();
    } catch (err) {
      if (isWrongPassword(err)) {
        setError(errorMessage(err));
      } else {
        toast.error(errorMessage(err));
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && (o ? onOpenChange(true) : close())}
      title={title}
      description="First, confirm it's you."
      size="sm"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="confirm-password" loading={busy}>
            Continue
          </Button>
        </>
      }
    >
      <form id="confirm-password" onSubmit={submit}>
        <PasswordField
          label="Your password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          autoFocus
          required
        />
      </form>
    </Dialog>
  );
}
