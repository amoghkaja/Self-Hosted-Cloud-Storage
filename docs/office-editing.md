# Editing documents in the browser

Family Cloud can open Word, Excel and PowerPoint files (`.docx`, `.xlsx`, `.pptx`, and the OpenDocument `.odt`, `.ods`, `.odp`) in a full editor in the browser, and save them back to the same file. It uses [Collabora Online](https://www.collaboraonline.com) (the free home edition, built on LibreOffice), which runs in a container of its own on your server. Nothing is sent to anyone else.

It is **optional and off by default**, because the editor needs memory: about 400 MB while nobody is using it, and more for each open document. Allow **1–2 GB**. A Raspberry Pi with 4 GB or less is usually better off without it.

## You can always turn it off completely

**Admin → Settings → Document editor** has a switch. Turning it off:

1. hides **Edit** for everyone straight away;
2. saves documents that are still open, then closes them;
3. removes the editor's container and its download within about a minute, which gives the memory and about 1.8 GB of disk space back.

Word, Excel and PowerPoint files then open as PDFs, as they did before. Turn it on again whenever you like from the same place. Your files aren't touched either way.

The switch starts and removes the editor through the update helper (see [Updating](self-hosting.md#updating)). Without the helper, the switch still hides and shows **Edit**, but the container stays until you run `./scripts/office.sh off` on the server. The panel tells you when that's the case.

## Adding it

On the server:

```bash
./scripts/office.sh on       # add the editor (asks for its address the first time)
./scripts/office.sh off      # remove it and give the memory back
./scripts/office.sh status
```

The editor needs **an address of its own** next to the family's, for example `https://office.example.com` next to `https://cloud.example.com`. Its pages then never run on the same address as Family Cloud, where everyone is signed in. `office.sh on` suggests one and sets it up for how your family reaches the server:

| How your family reaches it | What `office.sh on` does | What you do |
| --- | --- | --- |
| Cloudflare Tunnel | With `CLOUDFLARE_API_TOKEN=... ./scripts/office.sh on`, adds the address to your tunnel and DNS for you | Otherwise, add it to the tunnel yourself: Zero Trust → Networks → Tunnels → your tunnel → **Public hostname** → **Add**, hostname `office.example.com`, service **HTTP**, `app:3001` |
| Port forwarding + Caddy | Sets `OFFICE_DOMAIN`, so Caddy gets a certificate for it | Point the address at your server in DNS, as you did for `DOMAIN` |
| Tailscale | Suggests `https://<machine>.<tailnet>.ts.net:8443` | `sudo tailscale serve --bg --https=8443 3081` (once) |
| Only this computer | Uses `http://127.0.0.1:3081` | Nothing |

The first start downloads the editor (about 1.8 GB on disk) and takes a few minutes. After that, starting it takes seconds.

## Using it

- Open a Word, Excel or PowerPoint file and choose **Edit** at the top. It's offered to anyone who can change the file: its owner, and people it's shared with **with edit permission**. People who can only view it, and anyone with a public link, still see the PDF.
- Changes are saved as you go (every few minutes, and when you close the editor with its **×** button). Close it the same way when you're done.
- **Version history keeps the file as it was before each editing session**, so you can always go back, without a new version for every few minutes of typing.
- Two people can edit the same document at once and see each other's changes as they type.
- If the file is changed from somewhere else while it's open (the network drive, **Replace** on upload, a restored version), the editor asks whether to keep your version or load the new one, instead of overwriting either.
- It works on phones and tablets too, with a smaller toolbar.
- Older formats (`.doc`, `.xls`, `.ppt`, `.rtf`) and CSV aren't edited, because saving them again can lose formatting. They still open as PDFs. To edit one here, save it as `.docx` (or `.xlsx`, `.pptx`) in Word or LibreOffice and upload that.

## How it keeps files safe

- The editor reaches Family Cloud only through a private connection inside Docker, and has **no route to the internet**, so a document can't fetch anything from outside. It runs read-only, with no special permissions, and sandboxes each document.
- Each time someone opens a file, the editor gets a key for **that one file, as that person**, for 10 hours at most. It stops working when they sign out, when their access to the file is removed, or when it runs out. Every read and save checks their access again, so taking a share away cuts off an open editor.
- Saves go through the same checks as any other save: storage allowance, version history, and virus scanning if it's on. A file found to have a virus can't be opened in the editor.
- The editor's conversion and admin pages are never reachable from outside.

More detail: [security report](security.md).

## Settings

`./scripts/office.sh` sets these in `deploy/.env`; you rarely need to touch them:

| Setting | What it is |
| --- | --- |
| `OFFICE_PUBLIC_URL` | The editor's address. Empty: not set up. |
| `OFFICE_TLS` | `true` when that address is `https://` |
| `OFFICE_DOMAIN` | With Caddy: the editor's domain, for its certificate |
| `OFFICE_PORT` | The local port for the editor on Tailscale and local installs (3081) |

`COMPOSE_PROFILES` includes `office` while the editor is installed.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **Edit** doesn't appear | Check the switch in Admin → Settings → Document editor, and that the file is a `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods` or `.odp` you can change. |
| "The document editor isn't answering" | It may still be starting (a minute, longer the first time). If it stays, run `./scripts/office.sh status`, and `cd deploy && docker compose logs collabora`. |
| The editor opens but stays blank | The address isn't routed to the server yet (see the table under [Adding it](#adding-it)), or your browser blocks it: open `OFFICE_PUBLIC_URL` on its own; it should say "Not found". |
| The server got slow | Turn it off in Admin → Settings → Document editor: that gives the memory back. |
