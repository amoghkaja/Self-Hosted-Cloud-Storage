# Network drive (Files app, Finder, Windows)

Family Cloud includes a WebDAV server at `https://cloud.example.com/dav/`, so it can appear as a drive on phones and computers. It shows two folders:

- **My Files**: your own files.
- **Shared with me**: folders and files family members shared with you, with the same view/edit permissions as on the website.

## Device passwords

Network drives sign in with your **email** and a **device password**, never your normal password. Create one per device under **Settings → Network drive → Connect a device**. The dialog shows the server address, username and password, plus instructions for each platform.

Device passwords:

- are shown once, and can be typed with or without the dashes;
- can be removed individually (a lost phone doesn't mean changing your password);
- only work for the network drive, not for signing in to the website;
- don't ask for a two-factor code. That's why they're long and random. Remove unused ones.

## iPhone and iPad

The Files app can only connect to SMB servers by itself, not WebDAV, so you need a free helper app that adds itself to Files as a location. Examples: **Owlfiles**, **FE File Explorer**, **FileBrowser**, **Documents by Readdle**.

1. Install the helper app and add a **WebDAV** connection with the server, username and device password from the "Connect a device" dialog.
2. Open **Files → Browse → ⋯ → Edit** and switch on the helper app.

Family Cloud now appears next to iCloud Drive.

## Mac

Finder → **Go → Connect to Server…** (⌘K) → enter `https://cloud.example.com/dav/` → **Connect** → **Registered User** → email and device password. To reconnect automatically, add the server to **System Settings → General → Login Items**.

## Windows

File Explorer → right-click **This PC** → **Map network drive…** → Folder: `https://cloud.example.com/dav/` → tick **Connect using different credentials** → **Finish** → email and device password.

## Linux

In GNOME Files / Nautilus: **Other Locations → Connect to Server** → `davs://cloud.example.com/dav/`. Or mount with `davfs2`.

## Good to know

- **Deleting** from a network drive moves items to the website's **Trash**, so mistakes can be undone.
- **Saving over a file** keeps its sharing and links; only the contents change.
- **Large files through Cloudflare:** single files over 100 MB can't be uploaded through the network drive from outside your home (Cloudflare's per-request limit). Use the website's Upload button, which sends big files in pieces, or connect while on your home network / Tailscale, where there's no such limit.
- **Offline:** the network drive needs a connection. It isn't a sync client like Dropbox; files open from the server.
- Too many wrong passwords from one address lock that address out for a minute.
