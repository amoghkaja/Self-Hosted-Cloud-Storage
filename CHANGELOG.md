# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

### Fixed

- **Uploads:** when a file failed to upload, the rest of it no longer carries on sending in the
  background, using up your connection (and doubling up if you pressed Retry).
- **Uploads:** a moment without a connection no longer fails every file of a folder upload at
  once, and retrying or resuming a big upload no longer starts it again from the beginning if
  the connection drops just then.
- **Folder uploads:** empty folders inside a folder you drag in are made too, and dragging in an
  empty folder makes it. They used to be left out without a word.
- **Uploads:** cancelling a file of a folder upload works at once, even while its folder is still
  being made; pressing Retry straight after no longer shows it as cancelled while it uploads.
- **Keyboard:** the Name, Modified and Size column headers sort a folder with Enter or Space, as
  they do with a click. Enter used to open the first item in the folder instead.
- **Undo** after moving something to the trash brings it back on the Recent and Starred pages
  too, not only in its folder; until you reloaded, it stayed missing there.
- **Family Photos:** going back to an album right after deleting, renaming or moving one of its
  photos in the trip folder shows the change, instead of the photo as it was.
- **Rewind:** after rewinding a folder, Recent, Starred, Shared by me and the family albums show
  what came back straight away.
- **Passkeys:** when adding a passkey doesn't work (for example after leaving the Face ID prompt
  open for more than five minutes), you're told why instead of being bounced to the sign-in
  page and back.
- **Shared links, invites and password-reset links:** opening one while the server can't be
  reached (a phone between networks, the server restarting) says so and offers **Try again**,
  instead of claiming the link was removed or used up.

### Security

- **Shared computers:** when your session ends while Family Cloud is open (it expired, or you were
  signed out from another device), the page forgets your files, as signing out does. Whoever
  signed in next in that tab could briefly see your folders, recent files and search results.

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
