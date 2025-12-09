import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type SensorReading = {
  id: string;
  name: string | null;
  celsius: number | null;
  fahrenheit: number | null;
};

type HeaterStatus = {
  status: string | null;
  timeUntilStop: number | null;
};

type TemperatureResponse = {
  sensors: SensorReading[];
  heater: HeaterStatus;
  raw: string;
  fetchedAt: string;
};

const CAMERA_BASE_URL =
  process.env.CAMERA_HOST?.replace(/\/$/, "") || "http://10.0.0.42";
const TEMPERATURE_PATH =
  process.env.CAMERA_TEMPERATURE_PATH ||
  "/axis-cgi/temperaturecontrol.cgi?action=statusall";
const TIMEOUT_MS = 5000;

function parseTemperaturePayload(payload: string): TemperatureResponse {
  const sensors: Record<string, SensorReading> = {};
  const heater: HeaterStatus = {
    status: null,
    timeUntilStop: null,
  };

  payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [rawKey, rawValue = ""] = line.split("=");
      const key = rawKey.trim();
      const value = rawValue.trim();

      const sensorMatch = key.match(/^Sensor\.S(\d+)\.(Name|Celsius|Fahrenheit)$/);
      if (sensorMatch) {
        const [, sensorId, field] = sensorMatch;
        const id = `S${sensorId}`;
        sensors[id] ||= { id, name: null, celsius: null, fahrenheit: null };

        if (field === "Name") {
          sensors[id].name = value || null;
        } else if (field === "Celsius") {
          sensors[id].celsius = Number.isFinite(Number(value))
            ? Number(value)
            : null;
        } else if (field === "Fahrenheit") {
          sensors[id].fahrenheit = Number.isFinite(Number(value))
            ? Number(value)
            : null;
        }
        return;
      }

      if (key === "Heater.H0.Status") {
        heater.status = value || null;
      }

      if (key === "Heater.H0.TimeUntilStop") {
        heater.timeUntilStop = Number.isFinite(Number(value))
          ? Number(value)
          : null;
      }
    });

  return {
    sensors: Object.values(sensors).sort((a, b) => a.id.localeCompare(b.id)),
    heater,
    raw: payload,
    fetchedAt: new Date().toISOString(),
  };
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

export async function GET() {
  const url = `${CAMERA_BASE_URL}${TEMPERATURE_PATH.startsWith("/") ? "" : "/"}${TEMPERATURE_PATH}`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return NextResponse.json(
        { error: `Camera responded with ${res.status}` },
        { status: res.status }
      );
    }

    const text = await res.text();
    return NextResponse.json(parseTemperaturePayload(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to fetch camera temperature data: ${message}` },
      { status: 502 }
    );
  }
}
