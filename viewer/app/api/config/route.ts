import { NextResponse } from "next/server";

export async function GET() {
  const apiBase =
    process.env.NEXT_PUBLIC_PROXY_BASE || process.env.PROXY_BASE || "";
  const cameraIdRaw =
    process.env.NEXT_PUBLIC_CAMERA_ID || process.env.CAMERA_ID || "1";
  const streamUrl =
    process.env.NEXT_PUBLIC_STREAM_URL ||
    process.env.STREAM_URL ||
    (apiBase ? `${apiBase}/stream` : "");

  const cameraId = Number(cameraIdRaw);

  return NextResponse.json({
    apiBase,
    cameraId: Number.isFinite(cameraId) ? cameraId : 1,
    streamUrl,
  });
}
