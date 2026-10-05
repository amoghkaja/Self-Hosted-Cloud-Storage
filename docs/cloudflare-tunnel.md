# Cloudflare Tunnel

A tunnel lets people reach Family Cloud at `https://cloud.example.com` without opening any ports on your router. The `cloudflared` container makes an outbound connection to Cloudflare, and Cloudflare forwards visitors through it. It works behind carrier-grade NAT and keeps your home IP address private.

## Before you start

- Your domain must use Cloudflare's nameservers. If it doesn't yet: Cloudflare dashboard → **Add a domain**, then change the nameservers at your registrar. Cloudflare copies your existing DNS records (email etc.) during onboarding; check they're all there before switching.
- A free Cloudflare account is enough.

## The easy way: let the installer do it

Make an API token (My Profile → **API Tokens** → **Create Token** → **Create Custom Token**) with **Account · Cloudflare Tunnel · Edit**, **Zone · DNS · Edit** and **Zone · Zone · Read**, run `./scripts/install.sh`, choose **1** and paste it. The installer does everything below for you, including the DNS record, and doesn't keep the API token. The rest of this page is the manual way, which gives the same result.

## Create the tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**.
2. Choose **Cloudflared**, name it (e.g. `familycloud`), and save.
3. On the install page, choose **Docker** and copy the long token after `--token`. You don't need to run the command shown.
4. Put the token in `deploy/.env`:

   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
   ```

5. Start it: re-run `./scripts/install.sh` (your other settings are kept). It sets `COMPOSE_PROFILES=tunnel` in `deploy/.env` and starts `cloudflared`. The tunnel shows **Healthy** in the dashboard within a minute.

## Route your hostname to the app

In the tunnel → **Public hostname** (called "Published application routes" in newer dashboards) → **Add**:

| Field | Value |
| --- | --- |
| Subdomain | `cloud` |
| Domain | `example.com` |
| Service type | `HTTP` |
| URL | `app:3000` |

Save. Cloudflare creates the DNS record for `cloud.example.com` automatically.

> **Don't create that DNS record yourself first.** If a record for the hostname already exists, this step fails with "An A, AAAA, or CNAME record with that host already exists". Delete the old record and try again.

Make sure `PUBLIC_URL=https://cloud.example.com` in `deploy/.env` (then `cd deploy && docker compose up -d`).

## Recommended Cloudflare settings

All of these are optional and free:

- **SSL/TLS → Edge Certificates → Always Use HTTPS**: on. (The app also sends anyone who arrives over plain `http://` to your `https://` address, but doing it at Cloudflare saves a round trip.)
- **Caching → Cache Rules**: add a rule "URI Path starts with `/api/` or `/dav/`" → **Bypass cache**. The app already marks private responses `Cache-Control: private`; this rule is a second safeguard.
- **Security → WAF → Rate limiting rules**: e.g. requests to `/api/v1/auth/` limited to 20 per minute per IP. The app enforces its own limits too.
- **Zero Trust → Access → Applications**: protect `cloud.example.com/admin*` with a policy listing the admins' emails, for an extra sign-in in front of the admin pages.

## If the tunnel token leaks

Anyone with the token can run a connector for your tunnel and receive some of your visitors' traffic. If it was pasted somewhere public or shared by mistake:

1. Cloudflare dashboard → **Networking** → **Tunnels** → your tunnel → **Overview** → **Refresh token**. Copy the new token. The old one can no longer open new connections, but connectors already running with it stay connected.
2. Disconnect every connector, including any stranger's. This needs an API token with the **Cloudflare Tunnel: Edit** permission (My Profile → API Tokens); the account ID and tunnel ID are shown on the tunnel's page:

   ```bash
   curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" \
     --request DELETE --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
   ```

3. Put the new token in `CLOUDFLARE_TUNNEL_TOKEN` in `deploy/.env`, then `cd deploy && docker compose up -d cloudflared`. The site is unreachable from outside between steps 2 and 3.
4. Check the tunnel shows **Healthy** and that its only connector is yours.

## Limits to know

- **100 MB per request** on the free plan. The web app uploads in 32 MB pieces, so web uploads of any size work. Clients that upload a file in one request (the WebDAV network drive) can't upload single files over 100 MB through the tunnel; use the web app for those, or connect on your home network.
- **100-second response timeout.** Nothing in Family Cloud waits that long; downloads and zips stream continuously.
- Cloudflare's terms discourage using its CDN mainly for serving video. Private family use with caching bypassed is common, but if you stream a lot of video from outside, consider Tailscale for that.
