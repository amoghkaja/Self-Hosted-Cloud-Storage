import { Check, Copy, Share } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton, toast } from '../../components/ui';
import { copyText } from '../../lib/clipboard';
import { canShareNatively, shareNatively } from '../../lib/share';

export function CopyButton({ text, label }: { text: string; label: string }) {
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

/** The phone's share sheet (WhatsApp, Messages…); nothing on desktops, where copying is simpler. */
export function ShareButton({ url, title }: { url: string; title: string }) {
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

/** A link to hand to someone: shown in full (selectable), with share and copy buttons. */
export function LinkBox({
  url,
  title,
  copyLabel,
}: {
  url: string;
  title: string;
  copyLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{url}</code>
      <ShareButton url={url} title={title} />
      <CopyButton text={url} label={copyLabel} />
    </div>
  );
}
