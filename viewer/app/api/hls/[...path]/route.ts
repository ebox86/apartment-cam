import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const LOCALHOST = process.env.NODE_ENV === "development";
const DEFAULT_STREAM_URL = LOCALHOST
  ? "http://localhost:1984/api/stream.m3u8?src=axis&mp4"
  : "https://cam.ebox86.com/api/stream.m3u8?src=axis&mp4";
const STREAM_SOURCE =
  process.env.STREAM_URL ||
  process.env.NEXT_PUBLIC_STREAM_URL ||
  DEFAULT_STREAM_URL;

function buildStreamOrigin() {
  if (!STREAM_SOURCE) return null;
  try {
    const sourceUrl = new URL(STREAM_SOURCE);
    return `${sourceUrl.protocol}//${sourceUrl.host}`;
  } catch {
    return null;
  }
}

async function proxy(
  request: NextRequest,
  { params }: { params?: Promise<{ path?: string[] } | undefined> }
) {
  const origin = buildStreamOrigin();
  if (!origin) {
    return NextResponse.json(
      { error: "STREAM_URL is not configured" },
      { status: 502 }
    );
  }

  const resolvedParams = params ? await params : undefined;
  const path = (resolvedParams?.path || []).filter(Boolean).join("/");
  const upstreamUrl = new URL(`/api/hls/${path}`, origin);
  upstreamUrl.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  const contentType = responseHeaders.get("content-type") || "";
  if (contentType.includes("mpegurl") || upstreamUrl.pathname.endsWith(".m3u8")) {
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

export const GET = proxy;
export const HEAD = proxy;
