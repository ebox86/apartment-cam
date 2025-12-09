import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type GeolocationResponse = {
  location: {
    lat: number | null;
    lng: number | null;
    heading: number | null;
  };
  validity: {
    position: boolean | null;
    heading: boolean | null;
  };
  standardDeviation: {
    position: number | null;
    heading: number | null;
  };
  text: string | null;
  raw: string;
  fetchedAt: string;
};

const CAMERA_BASE_URL =
  process.env.CAMERA_HOST?.replace(/\/$/, "") || "http://10.0.0.42";
const GEOLOCATION_PATH =
  process.env.CAMERA_GEOLOCATION_PATH || "/axis-cgi/geolocation/get.cgi";
const CAMERA_USERNAME = process.env.CAMERA_USERNAME;
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD;
const TIMEOUT_MS = 5000;

function extractTagValue(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function toNumber(value: string | null): number | null {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value: string | null): boolean | null {
  if (value == null) return null;
  if (/^(true|1)$/i.test(value)) return true;
  if (/^(false|0)$/i.test(value)) return false;
  return null;
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}

function parseGeolocation(xml: string): GeolocationResponse {
  const lat = toNumber(extractTagValue(xml, "Lat"));
  const lng = toNumber(extractTagValue(xml, "Lng"));
  const heading = toNumber(extractTagValue(xml, "Heading"));
  const stdDevPosition = toNumber(extractTagValue(xml, "StandardDevPosition"));
  const stdDevHeading = toNumber(extractTagValue(xml, "StandardDevHeading"));

  return {
    location: {
      lat,
      lng,
      heading,
    },
    validity: {
      position: toBoolean(extractTagValue(xml, "ValidPosition")),
      heading: toBoolean(extractTagValue(xml, "ValidHeading")),
    },
    standardDeviation: {
      position: stdDevPosition,
      heading: stdDevHeading,
    },
    text: extractTagValue(xml, "Text"),
    raw: xml,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET() {
  if (!CAMERA_USERNAME || !CAMERA_PASSWORD) {
    return NextResponse.json(
      { error: "Camera credentials not configured." },
      { status: 500 }
    );
  }

  const url = `${CAMERA_BASE_URL}${GEOLOCATION_PATH.startsWith("/") ? "" : "/"}${GEOLOCATION_PATH}`;
  const authHeader = `Basic ${Buffer.from(`${CAMERA_USERNAME}:${CAMERA_PASSWORD}`).toString("base64")}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: authHeader,
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Camera responded with ${res.status}` },
        { status: res.status }
      );
    }

    const xml = await res.text();
    return NextResponse.json(parseGeolocation(xml));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to fetch camera geolocation data: ${message}` },
      { status: 502 }
    );
  }
}
