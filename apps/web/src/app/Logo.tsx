import { useEffect } from 'react';
import { apiUrl } from '../api/client';
import { useSetupStatus } from '../api/queries';
import { cn } from '../lib/cn';

/** The built-in mark, used until an admin uploads the family's own logo. */
function DefaultMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('text-brass', className)}>
      <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        fill="currentColor"
        d="M10.5 21.5a4 4 0 0 1-.4-8 5.6 5.6 0 0 1 10.8-1.3 4.7 4.7 0 0 1 .9 9.3z"
      />
    </svg>
  );
}

/** Just the mark (logo image or built-in), e.g. for favicons and compact headers. */
export function LogoMark({ className }: { className?: string }) {
  const version = useSetupStatus().data?.logoVersion;
  if (!version) return <DefaultMark className={className} />;
  return (
    <img
      src={apiUrl(`/brand/logo?v=${encodeURIComponent(version)}`)}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
    />
  );
}

/**
 * The lockup: the family's mark with the wordmark beside it in the display serif ("K Cloud").
 * `size` scales both together.
 */
export function Logo({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const setup = useSetupStatus().data;
  const name = setup?.appName ?? 'Family Cloud';
  const word = setup?.wordmark ?? name;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center',
        size === 'lg' ? 'gap-3' : 'gap-2.5',
        className,
      )}
    >
      <LogoMark
        className={cn('shrink-0', size === 'lg' ? 'size-12' : size === 'md' ? 'size-8' : 'size-7')}
      />
      <span
        // Read the full name instead when the word is only part of it (e.g. "Cloud").
        aria-hidden={word !== name || undefined}
        className={cn(
          'truncate font-display leading-none tracking-[0.01em]',
          size === 'lg' ? 'text-[32px]' : size === 'md' ? 'text-[22px]' : 'text-[19px]',
        )}
      >
        {word}
      </span>
      {word !== name && <span className="sr-only">{name}</span>}
    </span>
  );
}

/** Points the tab icon and the iPhone home-screen icon at the family's logo, once one is set. */
export function BrandIcons() {
  const version = useSetupStatus().data?.logoVersion;
  useEffect(() => {
    if (!version) return;
    const v = encodeURIComponent(version);
    const set = (rel: string, href: string, type?: string) => {
      let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.append(link);
      }
      link.href = href;
      if (type) link.type = type;
    };
    set('icon', apiUrl(`/brand/icon/192?v=${v}`), 'image/png');
    set('apple-touch-icon', apiUrl(`/brand/icon/180?v=${v}`));
  }, [version]);
  return null;
}
