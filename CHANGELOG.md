# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

### Security

- **Passkeys:** a passkey sign-in can no longer be sent a second time. Someone who copied one
  (from a saved browser log, say) within its five minutes could sign in with it again, because
  passkeys synced through iCloud Keychain or Google Password Manager don't count their uses.
- **Share links with a download limit** now count every download. A download program could ask
  for a file or a zip "in pieces" in a way that still sent all of it without counting, so the
  link never ran out.
- **Trip folders:** a document kept with a trip's photos (a boarding pass, a booking) isn't in
  the album, and now instant uploads treat it as private too. Before, a family member who had
  the very same file could upload it "instantly" and so find out it was there.
- **View-only links:** a video the browser can't play as it is (an `.mkv` or `.avi`, say) could
  be downloaded through the link's video player, even with downloads turned off, until its
  streaming copy was ready (or for good, if one couldn't be made). The player now waits for the
  streaming copy, and downloading the original follows the link's download settings.
- **Network drive:** a device removed in Settings (or an account disabled) at the moment that
  device was signing in could keep working for up to a minute. It's now locked out at once.
- **Network drive:** a signed-in device could stall the server for about a second with each
  specially made request.
- **Uploads:** a second copy of a piece of an upload, still being sent when the upload finished,
  could change the stored file afterwards (after its virus check, and in every copy of it). It is
  now stopped before the file is stored.
- **Videos:** a streaming playlist uploaded with a video's name made the background worker
  fetch the web addresses written in it (for example, other services on your home network) while
  making its thumbnail. Uploaded videos are now only ever read as video files from the disk.

### Fixed

- **File requests:** when the folder owner's storage is full, the person sending files is told
  so, instead of "Not enough storage left in your quota" (they don't have one).
- **Family Photos:** a trip can be edited again after someone on it has had their account
  disabled. Saving said "Someone in the list is not in the family", and there was no way round
  it; they now stay on the trip.
- **Network drive:** a partial upload (such as resuming one with `curl -C -`) is refused instead of
  replacing the whole file with just the part that was sent.
- **Network drive:** copying a file over another one (from apps like Cyberduck, Dolphin or
  rclone) saves over it like any other save: it keeps its sharing and links, and what it held
  goes to Version history. A copy over an item that fails (for example, not enough space) leaves
  that item as it was instead of moving it to the trash.
- **Version history:** files copied to the network drive from Finder or Windows no longer get an
  empty "older version" (both write an empty file before its contents). Empty files are never
  kept as versions.
- **Moving files off a disk:** an upload that finished at the very moment the move ran out of
  files could stay behind on the disk, which was then marked "Safe to unmount". It is now moved
  too before the disk is retired.
- **A disk unplugged for a while:** photos and videos on it never got thumbnails, dates or
  streaming copies, and documents were never searchable by their words, even after it was back.
  That work now waits for the disk and is done once it returns.
- **Previews of very large documents:** when LibreOffice took longer than 3 minutes, the preview
  was given up but LibreOffice went on running in the background, slowing the server down. It is
  now stopped.

## v0.5.0 (2026-10-05)

### Improved

- **Installing:** with a Cloudflare API token, the installer creates the Cloudflare Tunnel and its
  DNS record itself (no more copying a tunnel token from the dashboard). It carries on after
  installing Docker instead of asking you to log out and run it again, and before changing
  anything it checks the port is free and shows which disk your files will go on and how much
  room it has.

## v0.4.0 (2026-10-05)

### New

- **Family Photos:** trip albums are in the order photos were taken, whoever uploaded them first,
  with a heading for each day of the trip. The viewer shows when a photo was taken and, if the
  phone recorded it, a map of where. Photos already in your albums are sorted in the background
  after updating. Photos without a date (WhatsApp removes it) stay in upload order.
- **Free up space:** a page (from the storage bar, or Settings) that shows your biggest files,
  the same file stored more than once, older versions of files and what's in the trash, so you
  can see what takes up your space and let go of what you don't need.
- **Search inside files:** search finds PDFs, Word, Excel and PowerPoint files and text files by
  the words in them, not just their names, and shows the bit of text that matched. Files already
  stored are read in the background after updating (a large collection can take a few hours).
- **Rewind a folder:** put a folder (or all of My Files) back as it was an hour, a day or a week
  ago, or at any moment the trash still covers. Deleted files come back and files that were
  saved over get back what they held, and it shows you what will change first. Nothing is lost:
  what files hold now is kept as an older version.
- **Hearts and comments** on photos in trip albums: tap the heart, or open the comments under a
  photo, and see who loved it. The album shows which photos have hearts and comments.

### Fixed

- **Virus scanning:** files checked by v0.2.0 are now included in the daily re-check.

## v0.3.0 (2026-10-02)

### Improved

- **Virus scanning:** files sent through a file request can't be opened until they have been
  checked. Recent files are checked again daily for two weeks. Under Admin → Settings an admin
  can delete a blocked file or allow one the scanner got wrong. Previews and thumbnails of
  blocked files are blocked too.

## v0.2.0 (2026-10-02)

### New

- **Virus scanning** (optional): every upload can be checked with ClamAV on your own server.
  Infected files are marked and can't be opened or downloaded. Turn it on with
  `./scripts/virus-scan.sh on` (needs about 1.5 GB of memory), and pause it under Admin →
  Settings. See `docs/virus-scanning.md`.

### Improved

- **File requests** have their own **Request files** button in Files: it makes a new folder and
  a link to send to someone in one step. Every folder's menu has **Request files…** too.

### Security

- **File requests** now always have an end date (7 days unless you pick, 90 at most), take at
  most 1,000 files each, and refuse programs and scripts (`.exe`, `.bat`, `.apk` and the like).

## v0.1.0 (2026-10-02)

The first release.

### New

- **Files for everyone:** private My Files per person, with folders, drag-in folder uploads,
  big uploads that resume after a dropped connection, instant copies, Recent, Starred, and
  search as you type (including files shared with you).
- **Family Photos:** trip albums with dates and who went; everyone on the trip adds photos.
- **Viewing:** thumbnails and previews for photos (including HEIC), videos (streamed as 720p
  copies), PDFs and Word, Excel and PowerPoint files.
- **Sharing:** with family members (view or edit), public links with a password, expiry and
  download limit, a Shared by me page, and file request links for people without an account.
- **Version history:** saving over a file keeps what it held for 30 days.
- **Accounts:** invite links, allowed email domains, passkeys (Face ID / Touch ID), two-factor
  codes with recovery codes, password reset links, disabling and deleting accounts.
- **Network drive** (WebDAV) for Finder and Windows Explorer, with a password per device and a
  one-paste setup command on Windows. iPhones and iPads need a helper app to show it in Files.
- **What's new:** everyone sees the running version under Settings → About, with a What's new
  page listing what changed in each release.
- **Storage:** per-person allowances, a family limit, adding and retiring disks without a
  restart, and an admin overview of where the space goes.
- **Your family's look:** logo, wordmark and home link; light and dark themes; installs to a
  phone's home screen.
- **Privacy page** and a security log kept for a year.
- **Installing and updating:** the installer asks how your family will reach the cloud
  (Cloudflare Tunnel, your own domain, Tailscale or later), and can turn on weekly automatic
  updates. `./scripts/update.sh` backs up the database, updates, restarts and checks the result.
  Admin → Overview shows the version you run.
- **Backups:** `./scripts/backup-setup.sh` (offered at the end of installing) sets up nightly
  encrypted backups to another disk, another computer, Backblaze B2 or S3, and the Cloudflare
  guide explains what to do if a tunnel token leaks.
