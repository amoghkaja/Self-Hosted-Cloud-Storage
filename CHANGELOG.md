# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

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
- **Network drive** (WebDAV) for the iPhone Files app, Finder and Windows, with a password per
  device.
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
