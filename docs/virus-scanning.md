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
- **An infected file stays where it is**, marked **Virus found**, and can't be opened, downloaded, zipped or reached through a public link. Its owner deletes it. Admins see it under Admin → Settings, and it is written to the security log.
- If the scanner is stopped or still starting, uploads keep working and wait to be checked.

## What it doesn't do

- **It isn't a guarantee.** ClamAV catches known malware; brand-new threats and some malicious documents get past it. Keep the antivirus on your own computers.
- **Files over 100 MB are not checked** (the scanner's limit for one file). That is mostly videos.
- **A file can be downloaded in the seconds before its check finishes.** It is blocked from then on.
- File requests refuse programs and scripts by name whether or not scanning is on.

## Using your own scanner

If you already run `clamd` elsewhere, set `CLAMAV_HOST` (and `CLAMAV_PORT` if it isn't 3310) in `deploy/.env` to point at it, leave `clamav` out of `COMPOSE_PROFILES`, and run `docker compose up -d`. Files are streamed to it over TCP, so it needs no access to the storage disks.

## Trying it

Upload a text file containing the harmless [EICAR test string](https://www.eicar.org/download-anti-malware-testfile/). Within a minute it shows **Virus found**.
