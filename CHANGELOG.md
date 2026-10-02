# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

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
