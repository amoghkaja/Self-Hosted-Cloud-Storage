# Virus scanning

Family Cloud can check every upload with [ClamAV](https://www.clamav.net), a free, open-source virus scanner that runs in its own container on your server. Nothing is sent to anyone else.

It is **optional and off by default**, because the scanner needs about **1.5 GB of memory**. A Raspberry Pi 4 with 4 GB or less is better off without it.

## Turning it on and off

On the server:

```bash
./scripts/virus-scan.sh on       # add the scanner
./scripts/virus-scan.sh off      # remove it and give the memory back
./scripts/virus-scan.sh status
```

The installer asks the same question on a first install. The first start downloads the virus list (about 300 MB) and takes a few minutes; the scanner refreshes the list by itself after that.

To pause checking without removing the scanner, use **Admin → Settings → Check uploads for viruses**. The same place shows whether the scanner is answering, how many files still wait, and what was blocked.

## What it does

- **New uploads** are checked in the background a few seconds after they finish, however they arrived: the website, the network drive or a file request.
- **Files you already had** are checked too once scanning is on, about 2,000 an hour.
- **Files sent through a file request are held** until their check finishes: they show **Being checked** and can't be opened or downloaded before then. Your own family's uploads aren't held.
- **An infected file is quarantined where it is**, marked **Virus found**: it can't be opened, previewed, downloaded, zipped or reached through a public link. Its owner can delete it. It is written to the security log.
- **Admins decide what happens to it** under Admin → Settings → Blocked files: **Delete** moves every copy to its owner's trash, and **Allow anyway** releases a file the scanner got wrong (a false positive) and stops it being flagged again.
- **Recent files are checked again every day for two weeks**, because a new virus often gets added to the virus list days after it first appears.
- If the scanner is stopped or still starting, uploads keep working and wait to be checked.

## What it doesn't do

- **It isn't a guarantee.** ClamAV catches known malware; brand-new threats and some malicious documents get past it. Keep the antivirus on your own computers.
- **Files over 100 MB are not checked** (the scanner's limit for one file). That is mostly videos.
- **A family member's own upload can be downloaded in the seconds before its check finishes.** It is blocked from then on. (Files from file requests are held instead.)
- **Nobody is emailed** when something is caught: look at Admin → Settings, or the "Virus found" mark on the file.
- File requests refuse programs and scripts by name whether or not scanning is on.

## Using your own scanner

If you already run `clamd` elsewhere, set `CLAMAV_HOST` (and `CLAMAV_PORT` if it isn't 3310) in `deploy/.env` to point at it, and leave `clamav` out of `COMPOSE_PROFILES`. Files are streamed to it over TCP, so it needs no access to the storage disks.

The checking is done by the `worker` container, which has no network route off this server unless you give it one (it opens the photos, videos and documents people upload). Without one it can't reach your scanner: files wait to be checked forever, and those sent through a file request can't be opened. Create `deploy/docker-compose.override.yml` with:

```yaml
# Lets the worker reach a virus scanner on another computer.
services:
  worker:
    networks: [internal, updates]
```

Then run `docker compose up -d` in `deploy/`.

## Trying it

Upload a text file containing the harmless [EICAR test string](https://www.eicar.org/download-anti-malware-testfile/). Within a minute it shows **Virus found**.
