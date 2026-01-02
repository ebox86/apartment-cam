import { NextResponse } from "next/server";

export async function GET() {
  const useDirectProxy = process.env.NEXT_PUBLIC_DIRECT_PROXY === "1";
  const directApiBase =
    process.env.NEXT_PUBLIC_PROXY_BASE || process.env.PROXY_BASE || "";
  const internalProxyBase =
    process.env.NEXT_PUBLIC_INTERNAL_PROXY_BASE || "/api/cam-proxy";

  const apiBase = useDirectProxy
    ? directApiBase || internalProxyBase
    : internalProxyBase;

  const cameraIdRaw =
    process.env.NEXT_PUBLIC_CAMERA_ID || process.env.CAMERA_ID || "1";
  const streamUrl =
    process.env.NEXT_PUBLIC_STREAM_URL ||
    process.env.STREAM_URL ||
    (apiBase ? `${apiBase}/stream` : "");

  const toInternalStreamUrl = (value: string) => {
    if (!value) return value;
    try {
      const parsed = new URL(value);
      return `/api/stream${parsed.search}`;
    } catch {
      return value;
    }
  };

  const cameraId = Number(cameraIdRaw);

  return NextResponse.json({
    apiBase,
    cameraId: Number.isFinite(cameraId) ? cameraId : 1,
    streamUrl: toInternalStreamUrl(streamUrl),
  });
}
