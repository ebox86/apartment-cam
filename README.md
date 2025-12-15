# Apartment Cam
![!img](/public/ss.png)
## Overview 
<table style="border-collapse: collapse; border: none;">
  <tr style="border: none;">
    <td style="border: none; padding-right: 12px;">
      <img src="viewer/public/logo.png" alt="Apartment Cam logo" width="500" />
    </td>
    <td style="border: none; vertical-align: middle;">
      A lightweight viewer for a high-rise webcam in Pittsburgh (AXIS P3227-LVE Network Camera). The stack now ingests the Axis RTSP feed with go2rtc, publishes HLS through a Cloudflare Tunnel, and keeps the existing Next.js HUD/telemetry UI plus proxy for PTZ/metadata.
    </td>
  </tr>
</table>

## What’s inside
- **viewer/** – Next.js 16 app router UI (HUD overlay, stats panel, fullscreen toggle).
- **cam-proxy/** – Express proxy for telemetry/controls (used by the viewer UI).
- **go2rtc/** – Configuration for ingesting the Axis RTSP stream and serving HLS/API.
- **cloudflared/** – Cloudflare Tunnel ingress that exposes `cam.YOUR_DOMAIN` to go2rtc.
- **.github/workflows/** – GHCR build + Cloud Run deploy (Workload Identity Federation).

## Architecture
- `go2rtc` ingests the Axis RTSP stream (configured via `go2rtc/go2rtc.yaml`) and exposes HLS + a minimal HTTP API on port `1984` with `allow_paths` restricted to `/api`, `/api/streams`, and `/api/stream.m3u8`.
- `cloudflared` tunnels `cam.YOUR_DOMAIN` to `http://go2rtc:1984`, so the camera stream is never exposed directly to the public internet.
- `cam-proxy` remains responsible for camera telemetry, PTZ/zoom controls, and the status endpoints the viewer consumes.
- The Next.js viewer pulls telemetry from `cam-proxy` and plays the go2rtc HLS endpoint (`/api/stream.m3u8?src=axis&mp4`); Chrome/Firefox use `hls.js`, Safari uses native HLS, and WebRTC works only on the LAN because UDP streams do not flow through the tunnel.

## Environment & configuration
- Copy `.env.example` to `.env` and fill in your camera + tunnel credentials.
  - `CAMERA_HOST`, `CAMERA_USERNAME`, `CAMERA_PASSWORD`, and `CAMERA_TIMEOUT_MS` drive the telemetry/proxy endpoints.
  - `AXIS_HOST`, `AXIS_USER`, `AXIS_PASS`, and `AXIS_CAMERA` let go2rtc build the RTSP source that becomes the `axis` stream in `go2rtc/go2rtc.yaml`.
  - `TUNNEL_CREDENTIALS_FILE` should point at the named-tunnel JSON (e.g., `cloudflared/tunnel.json`); keep that file outside of git.
  - `TUNNEL_NAME` is the named tunnel’s ID or user-friendly name; it is passed directly to `cloudflared tunnel run`.
  - go2rtc reuses the same `CAMERA_HOST`, `CAMERA_USERNAME`, and `CAMERA_PASSWORD`; the Compose command strips `http[s]://` from `CAMERA_HOST` before starting go2rtc, so you don’t need to maintain a separate set of Axis env vars.
- Update `cloudflared/config.yml` to point `hostname` at your public domain (e.g., `cam.example.com`). The existing ingress already forwards `/` to `http://go2rtc:1984` and returns `http_status:404` for everything else.
- Keep private credentials out of git; `.env.example` is safe to track, but `.env` should stay local.

## Running locally
### Compose services
Docker Compose now runs `go2rtc`, `cloudflared`, and `cam-proxy` together.

```bash
docker compose up --build
# go2rtc: http://localhost:1984
# cam-proxy: http://localhost:3000
```

Make sure `.env` is populated (see above) and `cloudflared/config.yml` points at your public hostname. If you need to rebuild the proxy/viewer images, pass `--build` to `docker compose`.

### Viewer (Next.js)
```bash
cd viewer
npm install
npm run dev
# open http://localhost:3000
```

### Public playback
- The camera stream is now served as HLS at `https://cam.YOUR_DOMAIN/api/stream.m3u8?src=axis&mp4`. go2rtc exposes that endpoint, `cloudflared` routes the hostname to port `1984`, and the viewer relies on `hls.js` for non-Safari browsers while Safari uses its native HLS support.
- WebRTC (via go2rtc's `webrtc` module) still works on the LAN, but it generally fails over the Cloudflare Tunnel because UDP traffic cannot be forwarded. Use LAN/VPN/direct exposure if you need WebRTC playback beyond the tunnel.

## Container builds
- **Viewer Dockerfile:** `viewer/Dockerfile` (multi-stage, Node 20 Alpine, `npm run build`, `npm prune --production`, `npm start`).
- **Proxy Dockerfile:** `cam-proxy/Dockerfile` (Express passthrough).
- **GHCR tags:** `ghcr.io/<owner>/apartment-cam-viewer:latest` and `<sha>`; similar for `apartment-cam-proxy`.

## Deployment (Cloud Run)
- GitHub Actions workflow: `.github/workflows/viewer-image.yaml`
  - Build & push viewer image to GHCR.
  - Auth via WIF provider `gh-pool/gh-provider`.
  - Impersonate deploy SA (e.g., `ci-runner@portfolio-website-403402.iam.gserviceaccount.com`).
  - Deploy to Cloud Run; custom domain CNAME to `ghs.googlehosted.com`.
- Secrets to set in GitHub:
  - `GCP_WORKLOAD_IDENTITY_PROVIDER` – provider resource name.
  - `GCP_SERVICE_ACCOUNT_EMAIL` – deploy SA email.
  - Optional `CLOUD_RUN_IMAGE` override and app env vars (e.g., `STREAM_URL`, `NEXT_PUBLIC_STREAM_URL`).

## Notes
- The public stream hostname is the one configured in `cloudflared/config.yml` (e.g., `cam.example.com`). Keep that DNS entry behind Cloudflare and let the tunnel handle HTTPS.
- The viewer continues to use the telemetry endpoints in `cam-proxy` and plays the go2rtc HLS stream; it shows the offline banner whenever the HLS endpoint cannot be reached.
- WebRTC over the tunnel is unreliable because UDP cannot traverse Cloudflare's HTTP tunnel. Stick to LAN/VPN/direct access if you need WebRTC playback beyond local testing.
