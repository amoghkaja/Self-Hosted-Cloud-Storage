# Hardware and uptime

Family Cloud is only reachable while the computer running it is **on, awake and running Linux**. If it's switched off, asleep, or booted into another operating system, the cloud is offline until it's back.

## Choosing the machine

| Option | Idle power | Notes |
| --- | --- | --- |
| **Mini PC** (Intel N100/N150 class) | 6–10 W | Recommended. Quiet, cheap to run 24/7, fast enough for everything including thumbnails. |
| **Raspberry Pi 5** (8 GB) + USB/NVMe disks | 4–8 W | Works well; thumbnails of big photos and videos are slower. Use a good power supply and an NVMe HAT or powered USB hub for disks. |
| **Old laptop** | 8–15 W | Built-in battery doubles as a UPS. Check it's happy running lid-closed. |
| **Your desktop PC** | 40–100 W | Works, but it has to stay on and in Linux, and it costs noticeably more electricity per year. |

Memory: 2 GB is enough for a family; 4 GB or more is comfortable. The app uses about 150 MB of RAM when idle.

## If you run it on your everyday desktop

- **Turn off sleep and suspend:**

  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

- **Dual-boot with Windows?** While the PC is in Windows, the cloud is down. Alternatives:
  - run Windows in a virtual machine on Linux (KVM/virt-manager), so Linux keeps running; or
  - move Family Cloud to a small dedicated box ([moving guide](backup-restore.md#moving-to-new-hardware)) and use the desktop however you like.
- **Running it on Windows as well** isn't supported: you'd end up with two separate copies of everyone's files.

## Keeping it healthy

- **Automatic restarts:** the containers restart themselves after crashes and after a reboot (`restart: unless-stopped`), provided Docker starts on boot (`sudo systemctl enable docker`).
- **Security updates:** `sudo apt install unattended-upgrades` keeps the operating system patched.
- **Firewall:** with Cloudflare Tunnel nothing needs to be reachable from outside. Allow only SSH from your home network:

  ```bash
  sudo ufw default deny incoming
  sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
  sudo ufw enable
  ```

- **Power cuts:** a small UPS (or a laptop's battery) avoids unclean shutdowns. PostgreSQL recovers from them automatically, but disks prefer not to lose power mid-write.
- **Monitoring:** `https://cloud.example.com/readyz` returns `200` when the database and all disks are OK and `503` otherwise. Point a free uptime checker at it to get an alert when something is wrong.
