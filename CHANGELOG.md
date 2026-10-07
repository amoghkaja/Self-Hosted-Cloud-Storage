# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

### Improved

- **Phones and tablets:** the buttons above a folder fit on the screen. On a phone the last ones
  ran off its edge, which made the page slide sideways and could push the tab bar and the close
  buttons of previews and dialogs out of sight. Where there isn't room, Request files and Rewind
  are under the ⋮ button next to them.
- **Tablets:** file names in a folder had only a sliver of room beside the sidebar on an iPad
  held upright ("Docume…"). Until there's room for the date and size columns, they go under the
  name, as on a phone.
- **Folder path:** on a phone, a folder a few levels down showed "My F… › Docum… › Ta… › 2…".
  The path now keeps each name and slides sideways, starting at the folder you're in, whose name
  gets two lines.
- **Long file names:** when a name is too long for the list, the end of it (".pdf", ".jpg")
  stays in sight, so you can still tell what kind of file it is. The viewer shows the whole name
  on two lines, which on a phone is where you can read it.
- **Trash on phones:** names and where things were deleted from can be read in full (the Restore
  button sits under them), and Restore shows it's working, so a second tap doesn't try again.
- **Selecting on a phone or tablet:** a file's menu (⋮, or press and hold) now has **Select all**
  next to Select, so moving or downloading a whole folder's photos no longer takes a tap on each.
- **Two-factor sign-in on a phone:** setting it up on the phone that has your authenticator app
  no longer needs a second device to scan the code: tap **Open in your authenticator app**, or
  copy the key with one tap instead of typing 32 letters.
- **Admin → Activity on a phone:** every entry is laid out the same way (the time, then who did
  what), instead of breaking onto a second line in a different place each time.
- **Uploading on a small phone:** the upload list takes at most a quarter of the screen, so the
  folder and its buttons stay in view while a batch of photos goes up.
- **Rename:** the name is selected without its ending, as intended, so you can type the new name
  straight away and keep ".jpg". The cursor used to sit at the end of the name.
- **Deleting a link or file request** asks first. It used to go with one tap on the bin right
  next to Copy, and a deleted link can't be brought back (a new one has a different address).
- **iPhone home-screen app:** the bar that appears when you select files no longer slides half
  under the top bar while you scroll; its Clear button and the count were hidden there.
- **Undo on a phone:** the Undo and close buttons on messages like "Moved … to trash" are
  easier to hit with a thumb.
- **Deleting a comment on a photo** asks first, showing the comment. The bins of stacked
  comments sit right under each other, and the photo's owner can delete anyone's comment.

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
