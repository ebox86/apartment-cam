import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    apiBase: "https://cam-api.ebox86.com",
    cameraId: 1,
    streamUrl: "/api/stream?src=axis&mp4",
  });
}
