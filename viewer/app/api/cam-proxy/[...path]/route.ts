import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const targetBase =
  process.env.PROXY_BASE ||
  process.env.NEXT_PUBLIC_PROXY_BASE ||
  process.env.INTERNAL_PROXY_TARGET ||
  "http://localhost:3001";

const normalizePath = (value: string) => value.replace(/\/+$/, "");

function buildTargetUrl(pathSegments?: string[], query?: string) {
  const baseUrl = new URL(normalizePath(targetBase) || targetBase);
  const cleanedPath = (pathSegments || []).filter(Boolean);
  if (cleanedPath.length) {
    baseUrl.pathname = `${normalizePath(baseUrl.pathname)}/${cleanedPath.join("/")}`;
  }
  if (query) {
    baseUrl.search = query;
  }
  return baseUrl;
}

async function proxy(
  request: NextRequest,
  { params }: { params?: Promise<{ path?: string[] } | undefined> }
) {
  const resolvedParams = params ? await params : undefined;
  const upstreamUrl = buildTargetUrl(resolvedParams?.path, request.nextUrl.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", request.headers.get("host") || "");
  headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") || "https");

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
  return new NextResponse(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
