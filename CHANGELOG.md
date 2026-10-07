# Changelog

What changed in each Family Cloud release, newest first. `./scripts/update.sh` shows you the
entries between your version and the new one before it updates.

Versions are `vMAJOR.MINOR.PATCH` ([how they're chosen](docs/releasing.md)). Anything you have
to do yourself when updating is listed under **Before you update**.

## Unreleased

### Security

- **Passkeys, two-factor and network-drive passwords:** adding a passkey, turning on two-factor
  sign-in or connecting a device to the network drive now asks for your password first. Someone who got hold of a signed-in browser (a phone left unlocked, say)
  could otherwise add their own passkey and keep getting in after you changed your password, or
  turn on two-factor with their own app and lock you out of your account. Wrong passwords there
  (and when changing your password or getting new recovery codes) count toward the same lock as
  signing in.
- **Passkeys:** a passkey sign-in can no longer be sent a second time. Someone who copied one
  (from a saved browser log, say) within its five minutes could sign in with it again, because
  passkeys synced through iCloud Keychain or Google Password Manager don't count their uses.
- **Share links with a download limit** count every download that starts at the beginning of the
  file, and every zip. A download program could ask for a file or a zip "in pieces" in a way that
  still sent all of it without counting, so the link never ran out. (Picking up an interrupted
  download, which asks for the rest of a file, still doesn't count again.)
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
- **Shared computers:** when your session ends while Family Cloud is open (it expired, or you were
  signed out from another device), the page forgets your files, as signing out does. Whoever
  signed in next in that tab could briefly see your folders, recent files and search results.
- **Updating:** `update.sh` also downloads the newest builds of the database (PostgreSQL 18),
  Cloudflare Tunnel, Caddy and virus scanner images. They used to stay as they were on the day
  you installed, without their security fixes, and an old virus scanner stops getting new virus
  lists.

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
- **Free up space → Versions on a phone:** the explanation is no longer squeezed into a narrow
  column beside the "Delete all older versions" button.
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
- **Offline:** opening a folder or page with no connection says "You're offline" instead of
  showing grey placeholders forever, and loads by itself when the connection is back.
- **Deleting a comment on a photo** asks first, showing the comment. The bins of stacked
  comments sit right under each other, and the photo's owner can delete anyone's comment.
- **Updating:** if a new version crashes on start, the update goes back to the version you had by
  itself, with the database as it was just before. A bad automatic update on a Sunday morning no
  longer leaves the cloud down until you notice. The next update tries again.

### Fixed

- **Family Photos and Trash:** after a photo in a trip album is saved over (Replace, a restored
  version or Rewind), the album, its cover and the photo viewer show the new picture; they kept
  showing the old one, as the trash could for a photo restored, changed and deleted again.
- **Family Photos:** an album whose only picture was one of the hidden "._" files a Mac copies
  along no longer shows it as a broken cover.
- **Disaster-recovery export** (`cli export`) now includes files still waiting for their virus
  check. If the virus scanner was down, every recent upload was left out of the rebuilt folders.
- **Names with an invisible "NUL" character** (pasted from some apps) are refused with a
  message instead of an error page, everywhere you type text.
- **Family Photos:** photos copied into a trip folder from a Mac over the network drive no longer
  show up twice, once as a broken picture. Those were the hidden "._" files Finder writes beside
  each file it copies.
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
- **Names in Greek, Turkish and some other alphabets:** adding a file or folder whose name was
  already taken (a second "ΔΙΑΚΟΠΕΣ" folder, a second "İzmir.jpg", or "Make a copy" of one)
  failed instead of naming it "(1)", restoring one from the trash next to an item of the same
  name failed, and uploads didn't ask whether to replace the existing file.
- **Rewind a folder:** files and folders added after the moment you go back to, and deleted
  since, no longer come back out of the trash. They weren't there at that moment.
- **Copying a folder** (in the web app or on the network drive) silently left out files still
  waiting for their virus check, such as photos just sent through a file request. They're
  copied now, and open once the check is done, like the originals.
- **Network drive:** names containing one of two invisible "non-characters" (U+FFFE, U+FFFF)
  are refused. A file named that way, even one sent through a file request, could stop Finder
  and Windows from listing its folder.
- **Uploads:** when a file failed to upload, the rest of it no longer carries on sending in the
  background, using up your connection (and doubling up if you pressed Retry).
- **Uploads:** a moment without a connection no longer fails every file of a folder upload at
  once, and retrying or resuming a big upload no longer starts it again from the beginning if
  the connection drops just then.
- **Unfinished uploads:** opening Family Cloud on a poor connection no longer forgets uploads that
  were cut off earlier; they're still offered to continue once the server can be reached.
- **Unfinished uploads:** opening Family Cloud in a second tab while the first is still uploading
  no longer lists those uploads as "didn't finish", where **Discard** would have cancelled them.
- **Folder uploads:** empty folders inside a folder you drag in are made too, and dragging in an
  empty folder makes it. They used to be left out without a word.
- **Uploads:** cancelling a file of a folder upload works at once, even while its folder is still
  being made; pressing Retry straight after no longer shows it as cancelled while it uploads.
- **Thumbnails and photo previews** show the new picture after a photo is saved over (Replace on
  upload, restoring an older version, Rewind), in your files and on shared links. The browser
  kept showing the old one.
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
- **Backups:** when the backup disk isn't plugged in, the nightly backup stops with a message in
  its log. Before, it started a new backup in the empty folder the disk leaves behind, which is
  on the system disk, and could fill it with a copy of every file.
- **Backups:** after adding a disk with `scripts/add-disk.sh`, every off-site backup ended with an
  error and old backups were never cleaned up, because of the disk's `lost+found` folder (which
  only the system can read). That folder is now skipped.
- **Server:** the logs Docker keeps for each container are capped at 50 MB. They used to grow
  with every request until the containers were next replaced, and could fill the system disk.
- **Virus scanning:** the guide to using a scanner on another computer missed a step: the server
  couldn't reach it, so files waited to be checked forever and those sent through a file request
  couldn't be opened. See "Using your own scanner" in `docs/virus-scanning.md`.
- **Updating:** the database backup made before an update is now taken once the new version is
  downloaded or built, with the app stopped. It used to be taken first, so anything saved while
  the new version downloaded (or built, which takes a while on a Raspberry Pi) was missing from
  it. If the new version can't be built or the backup fails, the update now puts everything back
  as it was, instead of leaving the next version half set up.
- **Updating:** the images the previous version used are removed once the new one is running.
  They used to stay on the system disk, a few hundred MB with every update.
- **Adding a disk:** if `/etc/fstab` didn't end with a line break, `scripts/add-disk.sh` joined
  the new disk's line onto the last one, so after the next restart neither was mounted.

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
