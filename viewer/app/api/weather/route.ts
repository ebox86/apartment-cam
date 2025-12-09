import { NextResponse } from "next/server";

const DEFAULT_LAT = 40.4406;
const DEFAULT_LNG = -79.9959;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat") || `${DEFAULT_LAT}`);
  const lng = parseFloat(url.searchParams.get("lng") || `${DEFAULT_LNG}`);
  const key = process.env.OPENWEATHER_KEY;

  if (!key) {
    return NextResponse.json(
      { error: "OPENWEATHER_KEY not configured" },
      { status: 503 }
    );
  }

  const openWeatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(
    key
  )}&units=metric`;

  try {
    const res = await fetch(openWeatherUrl, { cache: "no-store" });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Weather HTTP ${res.status}`,
          detail,
        },
        { status: res.status }
      );
    }

    const json = await res.json();
    const windMs = json?.wind?.speed;
    return NextResponse.json({
      tempC: json?.main?.temp ?? null,
      description: json?.weather?.[0]?.description ?? null,
      humidity: json?.main?.humidity ?? null,
      windKph:
        windMs != null && Number.isFinite(windMs) ? Number(windMs) * 3.6 : null,
      icon: json?.weather?.[0]?.icon ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Weather fetch failed",
      },
      { status: 500 }
    );
  }
}
