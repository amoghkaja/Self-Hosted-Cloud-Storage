import { BRAND_LOGO_MAX_BYTES, BRAND_LOGO_TYPES, type Branding } from '@familycloud/shared';
import { ImageUp, Trash2 } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useBranding, useBrandingMutations } from '../../api/queries';
import { Logo } from '../../app/Logo';
import { Button, QueryState, Skeleton, TextField, toast } from '../../components/ui';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function BrandingForm({ initial }: { initial: Branding }) {
  const m = useBrandingMutations();
  const file = useRef<HTMLInputElement>(null);
  const [wordmark, setWordmark] = useState(initial.wordmark ?? '');
  const [homeUrl, setHomeUrl] = useState(initial.homeUrl ?? '');

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!(BRAND_LOGO_TYPES as readonly string[]).includes(f.type)) {
      toast.error('Choose an SVG, PNG or WebP image.');
      return;
    }
    if (f.size > BRAND_LOGO_MAX_BYTES) {
      toast.error('The logo must be 256 KB or smaller.');
      return;
    }
    try {
      await m.uploadLogo.mutateAsync({ mimeType: f.type, data: await toBase64(f) });
      toast.success('Logo updated');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await m.update.mutateAsync({
        wordmark: wordmark.trim() || null,
        homeUrl: homeUrl.trim() || null,
      });
      toast.success('Branding saved');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <form onSubmit={save} className="flex max-w-lg flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Logo</p>
        <div className="flex min-h-20 items-center rounded-xl border border-border bg-bg px-4 py-3">
          <Logo size="lg" />
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={file}
            type="file"
            accept={BRAND_LOGO_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={upload}
          />
          <Button
            icon={<ImageUp size={16} />}
            loading={m.uploadLogo.isPending}
            onClick={() => file.current?.click()}
          >
            {initial.hasLogo ? 'Replace logo' : 'Upload logo'}
          </Button>
          {initial.hasLogo && (
            <Button
              variant="ghost"
              icon={<Trash2 size={16} />}
              loading={m.removeLogo.isPending}
              onClick={() =>
                m.removeLogo.mutate(undefined, {
                  onSuccess: () => toast.success('Back to the built-in logo'),
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              Use the built-in logo
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">
          A square mark works best (SVG, PNG or WebP, up to 256 KB). It's also used for the browser
          tab and the home-screen icon.
        </p>
      </div>
      <TextField
        label="Word beside the logo"
        value={wordmark}
        onChange={(e) => setWordmark(e.target.value)}
        maxLength={40}
        placeholder="e.g. Cloud"
        hint="Leave empty to show the app's name."
      />
      <TextField
        label="Family website"
        type="url"
        inputMode="url"
        value={homeUrl}
        onChange={(e) => setHomeUrl(e.target.value)}
        placeholder="https://example.com"
        hint="Shown as a link back on the sign-in page and in the menu."
      />
      <Button type="submit" variant="primary" loading={m.update.isPending} className="self-start">
        Save branding
      </Button>
    </form>
  );
}

export function BrandingCard() {
  const q = useBranding();
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-base font-semibold">Branding</h2>
      <QueryState query={q} loading={<Skeleton className="h-48" />}>
        {(b) => <BrandingForm initial={b} />}
      </QueryState>
    </section>
  );
}
