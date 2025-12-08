# Apartment Cam
![!img](/public/ss.png)
## Overview 
<table style="border-collapse: collapse; border: none;">
  <tr style="border: none;">
    <td style="border: none; padding-right: 12px;">
      <img src="viewer/public/logo.png" alt="Apartment Cam logo" width="500" />
    </td>
    <td style="border: none; vertical-align: middle;">
      A lightweight MJPEG viewer for a high-rise webcam in Pittsburgh (AXIS P3227-LVE Network Camera). The stack is split into a tiny proxy that fronts the camera stream and a Next.js viewer that adds HUD-style overlays, fullscreen controls, and a custom domain via Cloud Run.
    </td>
  </tr>
</table>

## What’s inside
- **viewer/** – Next.js 16 app router UI (HUD overlay, stats panel, fullscreen toggle).
- **cam-proxy/** – Express passthrough to the camera (pipes MJPEG to the viewer).
- **.github/workflows/** – GHCR build + Cloud Run deploy (Workload Identity Federation).

## Architecture
- Camera MJPEG feed is proxied by `cam-proxy` (`GET /stream`), which forwards the body as-is and sets `Cache-Control: no-store`.
- Viewer consumes the proxy stream and renders overlays (location, status, “LIVE” pill) plus a stats grid and offline fallback.
- Containers are built and pushed to GHCR; Cloud Run serves the viewer on the custom domain (`apt-cam.ebox86.com`) with HTTPS.
- Deploys use GitHub → GCP Workload Identity Federation; the deploy service account trusts the GitHub principal (owner + repo binding).

## Running locally
### Viewer (Next.js)
```bash
cd viewer
npm install
npm run dev
# open http://localhost:3000
```

### Proxy
```bash
cd cam-proxy
npm install
CAM_URL="http://<your-camera-host>/stream" npm start
# proxy available on http://localhost:3000/stream
```

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
- Custom domain: `apt-cam.ebox86.com` CNAME → `ghs.googlehosted.com`.
- If fronting with Cloudflare, use DNS-only + Full (strict) to avoid redirect loops.
- The viewer currently points to the configured stream URL; offline state shows a red banner if the stream fails.
