import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    apiBase: "https://cam-api.ebox86.com",
    cameraId: 1,
    streamUrl: "https://cam.ebox86.com/api/stream.m3u8?src=axis&mp4",
  });
}
