import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STREAM_SOURCE = "https://cam.ebox86.com/api/stream.m3u8?src=axis";

function buildStreamTarget(request: NextRequest) {
  if (!STREAM_SOURCE) return null;
  const sourceUrl = new URL(STREAM_SOURCE);
  const target = new URL(sourceUrl.toString());
  target.search = request.nextUrl.search || sourceUrl.search;
  return target;
}

export async function GET(request: NextRequest) {
  const target = buildStreamTarget(request);
  if (!target) {
    return NextResponse.json(
      { error: "STREAM_URL is not configured" },
      { status: 502 }
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");
  const response = await fetch(target.toString(), {
    method: "GET",
    headers,
    redirect: "manual",
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  const contentType = responseHeaders.get("content-type") || "";
  if (contentType.includes("mpegurl") || target.pathname.endsWith(".m3u8")) {
    const origin = new URL(STREAM_SOURCE).origin;
    const text = await response.text();
    const rewritten = text.split(origin).join(request.nextUrl.origin);
    responseHeaders.delete("content-length");
    return new NextResponse(rewritten, {
      status: response.status,
      headers: responseHeaders,
    });
  }
  responseHeaders.delete("content-length");
  return new NextResponse(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

export const HEAD = GET;
