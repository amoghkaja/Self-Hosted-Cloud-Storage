# Network drive (Finder, Windows, Linux)

Family Cloud includes a WebDAV server at `https://cloud.example.com/dav/`, so it appears as a drive in Finder and Windows Explorer with nothing to install. iPhones and iPads need a helper app for that; see below. It shows two folders:

- **My Files**: your own files.
- **Shared with me**: folders and files family members shared with you, with the same view/edit permissions as on the website.

## Device passwords

Network drives sign in with your **email** and a **device password**, never your normal password. Create one per device under **Settings → Network drive → Connect a device** (it asks for your normal password first). The dialog shows the server address, username and password, plus instructions for each platform.

Device passwords:

- are shown once, and can be typed with or without the dashes;
- can be removed individually (a lost phone doesn't mean changing your password);
- only work for the network drive, not for signing in to the website;
- don't ask for a two-factor code. That's why they're long and random. Remove unused ones.

## Mac

Finder → **Go → Connect to Server…** (⌘K) → enter `https://cloud.example.com/dav/` → **Connect** → **Registered User** → email and device password, and tick **Remember this password in my keychain**.

Drag the drive into the Finder sidebar to keep it handy. To reconnect automatically, add it under **System Settings → General → Login Items**.

## Windows

The "Connect a device" dialog shows a command with your details filled in. Press **Win + R**, type `cmd`, press Enter, paste the command and press Enter. It saves the device password and maps a drive that comes back after a restart:

```
cmdkey /add:cloud.example.com /user:you@example.com /pass:DEVICE-PASSWORD && net use * \\cloud.example.com@SSL\dav /persistent:yes
```

Or by hand: File Explorer → right-click **This PC** → **Map network drive…** → Folder: `https://cloud.example.com/dav/` → tick **Connect using different credentials** → **Finish** → email and device password.

### Files over 50 MB on Windows

Windows refuses to open or save network-drive files over 50 MB until its own limit is raised. In a Command Prompt opened with **Run as administrator**:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f
net stop webclient & net start webclient
```

That raises it to 4 GB, the most Windows allows. Through Cloudflare, uploads are still limited to 100 MB (see below).

## Linux

In GNOME Files / Nautilus: **Other Locations → Connect to Server** → `davs://cloud.example.com/dav/`. Or mount with `davfs2`.

## iPhone and iPad

The Files app can only connect to SMB servers by itself, not WebDAV, and SMB can't travel through a Cloudflare Tunnel. So there are two options:

- **The website, on your home screen.** Open it in Safari → **Share** → **Add to Home Screen**. It then opens like an app; uploads pick from Files and Photos, and downloads save to Files. Nothing else to install.
- **A helper app**, if you want Family Cloud as a location inside Files. Examples: **Owlfiles**, **FE File Explorer**, **FileBrowser**, **Documents by Readdle**.
  1. Install the helper app and add a **WebDAV** connection with the server, username and device password from the "Connect a device" dialog.
  2. Open **Files → Browse → ⋯ → Edit** and switch on the helper app. Family Cloud now appears next to iCloud Drive.

## Good to know

- **Deleting** from a network drive moves items to the website's **Trash**, so mistakes can be undone.
- **Saving over a file** keeps its sharing and links; only the contents change. What it held before is kept in **Version history** (in the file's menu on the website) for 30 days by default, so a save that went wrong can be undone. Apps that save by writing a temporary file and renaming it over the original (Word, Excel, LibreOffice) get the same treatment.
- **Copying** a file or folder in Finder or Explorer is instant: the copy shares the stored bytes until one of them changes. It still counts toward the storage of whoever owns the folder it lands in.
- **Large files through Cloudflare:** single files over 100 MB can't be uploaded through the network drive from outside your home (Cloudflare's per-request limit). Use the website's Upload button, which sends big files in pieces, or connect while on your home network / Tailscale, where there's no such limit.
- **Offline:** the network drive needs a connection. It isn't a sync client like Dropbox; files open from the server.
- Too many wrong passwords from one address lock that address out for a minute.
