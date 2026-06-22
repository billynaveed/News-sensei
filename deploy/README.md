# Deployment / routing

The app listens on `0.0.0.0:5000` (plain HTTP). Public access is fronted by
**Cloudflare → nginx on the VPS (77.42.84.43) → app on :5000**.

## Make `sensei.billynaveed.com` serve the app

DNS is already correct: a wildcard `*.billynaveed.com` A record points to the VPS
(Cloudflare-proxied). The only missing piece is an nginx vhost on the VPS — without
it, nginx serves the default `billynaveed.com` site for the `sensei.*` Host.

On the VPS (`77.42.84.43`):

```bash
# 1. Install the vhost
sudo cp deploy/nginx/sensei.billynaveed.com.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/sensei.billynaveed.com.conf /etc/nginx/sites-enabled/

# 2. Make sure the ssl_certificate paths in that file exist (see the comments in
#    it). If you have a Cloudflare Origin cert or a *.billynaveed.com wildcard cert,
#    point to it; otherwise: sudo certbot --nginx -d sensei.billynaveed.com

# 3. Validate + reload
sudo nginx -t && sudo systemctl reload nginx
```

Then verify (should be the app, not the homepage):

```bash
curl -I https://sensei.billynaveed.com/healthz   # expect 200 {"status":"ok",...}
```

## Point the app's auth at the new domain

WebAuthn/passkey login is bound to the origin. Set these in the app's environment
(systemd unit env / `.env`) and restart the app, or passkey registration/login will
fail with an origin mismatch:

```
WEBAUTHN_RP_ID=sensei.billynaveed.com
WEBAUTHN_ORIGIN=https://sensei.billynaveed.com
```

## Cloudflare note

Keep the `sensei` record proxied (orange cloud). Use SSL/TLS mode **Full** or
**Full (strict)** so Cloudflare talks HTTPS to the nginx origin. If you ever see a
redirect loop, it's almost always the SSL/TLS mode (Flexible) fighting nginx's
HTTP→HTTPS redirect — set it to Full.
