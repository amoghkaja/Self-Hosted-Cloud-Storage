import { Fingerprint, X } from 'lucide-react';
import { useState } from 'react';
import { usePasskeyMutations, usePasskeys } from '../api/queries';
import { Button, IconButton, toast } from '../components/ui';
import { passkeyError, passkeysSupported } from '../lib/passkeys';

const KEY = 'fc-passkey-nudge-dismissed';

function dismissed() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

/** A one-time invitation to set up Face ID / Touch ID sign-in, for people without a passkey. */
export function PasskeyNudge() {
  const [hidden, setHidden] = useState(dismissed);
  const q = usePasskeys();
  const m = usePasskeyMutations();
  if (hidden || !passkeysSupported() || !q.data || q.data.length > 0) return null;
  const hide = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {}
    setHidden(true);
  };
  const add = async () => {
    try {
      await m.add.mutateAsync();
      toast.success('Done! Next time, sign in with Face ID or Touch ID.');
      hide();
    } catch (err) {
      const message = passkeyError(err);
      if (message) toast.error(message);
    }
  };
  return (
    <section
      aria-label="Faster sign-in"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-2 text-sm md:px-6"
    >
      <Fingerprint size={16} aria-hidden className="text-accent" />
      <span className="min-w-0 flex-1">Sign in faster next time with Face ID or Touch ID.</span>
      <Button size="sm" variant="primary" loading={m.add.isPending} onClick={add}>
        Set up
      </Button>
      <IconButton label="Not now" icon={<X />} size="sm" onClick={hide} />
    </section>
  );
}
