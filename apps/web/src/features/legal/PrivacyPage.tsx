import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useMe, useSetupStatus } from '../../api/queries';
import { Logo } from '../../app/Logo';
import { Skeleton } from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const list = 'list-disc space-y-1.5 pl-5';

/**
 * What this server keeps about people, who can see their files, and what it never does. Written
 * from what the software actually does; the admin can add who runs it and their own terms.
 */
export function PrivacyPage() {
  const setup = useSetupStatus().data;
  const signedIn = !!useMe().data;
  usePageTitle('Privacy');
  const name = setup?.appName ?? 'Family Cloud';
  const back = signedIn ? '/files' : '/login';
  return (
    <div className="min-h-dvh px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <header className="mx-auto flex max-w-2xl items-center justify-between py-4">
        <Logo size="sm" />
        <Link
          to={back}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted hover:text-text"
        >
          <ArrowLeft size={14} aria-hidden />
          {signedIn ? 'Back to my files' : 'Sign in'}
        </Link>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-7 text-[15px] leading-relaxed">
        <div>
          <h1 className="font-serif text-[32px] leading-tight">Privacy</h1>
          <p className="mt-2 text-muted">
            {name} is a private cloud that a family runs on its own computer. Here's what it keeps
            about you, who can see your files, and what it doesn't do.
          </p>
        </div>

        <Part title="Who runs it">
          <p>
            The people who set up this server run it, not the makers of the software. If you have a
            question, ask them (usually whoever invited you).
          </p>
          {setup?.privacyNotice && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="mb-1 text-sm font-medium">From the people who run this server</p>
              <p className="text-sm whitespace-pre-line">{setup.privacyNotice}</p>
            </div>
          )}
        </Part>

        <Part title="What it keeps">
          {setup ? (
            <ul className={list}>
              <li>
                Your account: your name, email address and a scrambled form of your password (never
                the password itself). Two-factor secrets are stored encrypted, and passkeys only as
                public keys.
              </li>
              <li>
                Your files and folders, on this server's own disks, with their names, sizes and
                dates, plus small previews (thumbnails, video and document previews) so they open
                quickly.
              </li>
              <li>
                For photos and videos, when and where they were taken, read from what your phone
                saved in the file, so albums can show them in order and on a map.
              </li>
              <li>
                The words in your documents (PDFs, Office files and text), so search can find files
                by what's in them. Only people who can see a file can find it this way.
              </li>
              {setup.versionRetentionDays > 0 && (
                <li>
                  Older versions of files that are saved over, for {setup.versionRetentionDays}{' '}
                  days.
                </li>
              )}
              <li>
                Deleted items, in the trash for {setup.trashRetentionDays} days before they're gone
                for good.
              </li>
              <li>
                The devices you're signed in on (browser, IP address, when last used), so you can
                see and end them in Settings. A sign-in lasts at most 90 days.
              </li>
              <li>
                A security log that admins can read: sign-ins and failed sign-ins, sharing, and
                permanent deletions. It records what happened, not what's in your files, and entries
                are removed after a year.
              </li>
            </ul>
          ) : (
            <Skeleton className="h-32" />
          )}
        </Part>

        <Part title="Who can see your files">
          <ul className={list}>
            <li>
              Only you, until you share something. Admins manage accounts and storage; the app
              doesn't let them open your files.
            </li>
            <li>
              People you share with, and anyone with a public link you made, until it expires or you
              remove it. Someone sending you files through a file request can't see anything in the
              folder.
            </li>
            <li>
              Everyone in the family can see the trip albums in Family Photos, including when and
              where each photo was taken.
            </li>
          </ul>
        </Part>

        <Part title="Cookies and tracking">
          <ul className={list}>
            <li>
              Only the cookies needed for it to work: one that keeps you signed in, and a
              short-lived one when you open a password-protected link. Because they're strictly
              necessary, there's nothing to accept or decline.
            </li>
            <li>
              No advertising, no analytics, no tracking, and nothing about you is sold or shared
              with other companies.
            </li>
            <li>
              Your browser also remembers a few preferences on your device: light or dark theme,
              list or grid, sort order, uploads to resume, and the name you give on file requests.
            </li>
          </ul>
        </Part>

        <Part title="Where your data goes">
          <ul className={list}>
            <li>
              Your files stay on this server's disks. If it's reached through a service such as
              Cloudflare, traffic passes through that service's network on the way (encrypted
              between your device and it).
            </li>
            <li>
              The server doesn't send your data anywhere else, and it asks search engines not to
              list it.
            </li>
          </ul>
        </Part>

        <Part title="Your choices">
          <ul className={list}>
            <li>Download any file, or a whole folder as a zip, at any time.</li>
            <li>
              Delete files: they go to the trash first, and “Delete forever” removes them at once.
            </li>
            <li>
              Change your password, turn on two-factor sign-in or passkeys, and sign out other
              devices, in Settings.
            </li>
            <li>To have your account and everything in it removed, ask an admin.</li>
          </ul>
        </Part>
      </main>
    </div>
  );
}
