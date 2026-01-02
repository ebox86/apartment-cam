import express from "express";
import fetch from "node-fetch";
import DigestFetch from "digest-fetch";
import http from "http";
import https from "https";

const app = express();
app.use(express.json());
// Simple CORS to allow browser fetches from the viewer (different origin)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const CAM_URL = process.env.CAM_URL;
const CAMERA_HOST = (process.env.CAMERA_HOST || "http://10.0.0.42").replace(
  /\/$/,
  ""
);
const CAMERA_USERNAME = process.env.CAMERA_USERNAME;
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD;
const CAMERA_TIMEOUT_MS = Number(process.env.CAMERA_TIMEOUT_MS || 5000);
const CAMERA_STREAM_ID =
  process.env.CAMERA_STREAM_ID ||
  process.env.CAMERA_ID ||
  process.env.CAMERA ||
  "";
const CAMERA_STREAM_PROFILE = process.env.CAMERA_STREAM_PROFILE || "";
const digestClient =
  CAMERA_USERNAME && CAMERA_PASSWORD
    ? new DigestFetch(CAMERA_USERNAME, CAMERA_PASSWORD)
    : null;

const PTZ_MIN_ZOOM_DEFAULT = 1;
const PTZ_MAX_ZOOM_DEFAULT = 9999;
const STATUS_CACHE_MS = Number(process.env.STATUS_CACHE_MS || 7000);
const CAPS_CACHE_MS = Number(process.env.CAPS_CACHE_MS || 60000);
const httpAgent = new http.Agent({ keepAlive: true });
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function authHeaders() {
  if (!CAMERA_USERNAME || !CAMERA_PASSWORD) return {};
  const basic = Buffer.from(`${CAMERA_USERNAME}:${CAMERA_PASSWORD}`).toString(
    "base64"
  );
  return {
    Authorization: `Basic ${basic}`,
  };
}

function buildUrl(path) {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  return `${CAMERA_HOST}${path}`;
}

async function fetchWithTimeout(path, init = {}) {
  const url = buildUrl(path);
  const timeoutMs = CAMERA_TIMEOUT_MS > 0 ? CAMERA_TIMEOUT_MS : 5000;
  const headers = { ...(init.headers || {}) };
  const agent =
    init.agent ??
    (url.startsWith("https://") ? insecureAgent : httpAgent);

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  const fetchPromise = (async () => {
    if (digestClient) {
      const resp = await digestClient.fetch(url, {
        ...init,
        headers,
        agent,
      });
      if (resp.status === 401) {
        console.warn("Camera 401 via digest", { url });
      }
      return resp;
    }

    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        headers: { ...authHeaders(), ...headers },
        agent,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(abortId);
    }
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseKvBody(text) {
  const out = {};
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [rawKey, ...rest] = line.split("=");
      if (!rawKey) return;
      const key = rawKey.trim().replace(/^root\./, "");
      out[key] = rest.join("=").trim();
    });
  return out;
}

async function getPtzStatus(camera) {
  try {
    const path = camera
      ? `/axis-cgi/com/ptz.cgi?query=position&camera=${encodeURIComponent(
          camera
        )}`
      : "/axis-cgi/com/ptz.cgi?query=position";
    const res = await fetchWithTimeout(path, {
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      // Secondary fallback path for older PTZ path
      const ptzAltRes = await fetchWithTimeout(
        camera
          ? `/axis-cgi/ptz.cgi?query=position&camera=${encodeURIComponent(
              camera
            )}`
          : "/axis-cgi/ptz.cgi?query=position",
        { headers: { Accept: "text/plain" } }
      );
      if (!ptzAltRes.ok) {
        return {
          error: `HTTP ${res.status}`,
          detail: await res.text().catch(() => undefined),
        };
      }
      const altText = (await ptzAltRes.text()).trim();
      const altParts = altText.split(/\s+/);
      const altKv = {};
      for (const part of altParts) {
        const [k, v] = part.split("=");
        if (k) altKv[k] = v;
      }
      const toNumber = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        raw: altText,
        magnification: toNumber(altKv.zoom),
        pan: toNumber(altKv.pan),
        tilt: toNumber(altKv.tilt),
        zoomMoving: null,
        focusPosition: null,
        autofocus: altKv.autofocus || null,
        autoiris: altKv.autoiris || null,
      };
    }

    const text = (await res.text()).trim();
    const parts = text.split(/\s+/);
    const kv = {};
    for (const part of parts) {
      const [k, v] = part.split("=");
      if (k) kv[k] = v;
    }

    const toNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      raw: text,
      magnification: toNumber(kv.zoom),
      pan: toNumber(kv.pan),
      tilt: toNumber(kv.tilt),
      zoomMoving: null,
      focusPosition: null,
      autofocus: kv.autofocus || null,
      autoiris: kv.autoiris || null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "unknown error" };
  }
}

async function getGeolocation() {
  try {
    const res = await fetchWithTimeout("/axis-cgi/geolocation/get.cgi", {
      headers: { Accept: "application/xml,text/xml" },
    });
    if (!res.ok) {
      return {
        error: `HTTP ${res.status}`,
        detail: await res.text().catch(() => undefined),
      };
    }
    const xml = await res.text();
    const extract = (tag) => {
      const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
      return match ? match[1].trim() : null;
    };
    const toNumber = (v) => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toBoolean = (v) => {
      if (v == null) return null;
      if (/^(true|1)$/i.test(v)) return true;
      if (/^(false|0)$/i.test(v)) return false;
      return null;
    };

    return {
      lat: toNumber(extract("Lat")),
      lng: toNumber(extract("Lng")),
      heading: toNumber(extract("Heading")),
      text: extract("Text"),
      valid: toBoolean(extract("ValidPosition")),
      validHeading: toBoolean(extract("ValidHeading")),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "unknown error" };
  }
}

async function getStreams() {
  try {
    const res = await fetchWithTimeout("/axis-cgi/streamstatus.cgi", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ method: "getAllStreams", apiVersion: "1.1" }),
    });
    if (!res.ok) {
      // Fallback: list media params (best-effort)
      try {
        const mediaRes = await fetchWithTimeout(
          "/axis-cgi/param.cgi?action=list&group=Media",
          { headers: { Accept: "text/plain" } }
        );
        if (mediaRes.ok) {
          const kv = parseKvBody(await mediaRes.text());
          const streams = Object.entries(kv)
            .filter(([key]) => /\.Name$/.test(key))
            .map(([key, val]) => {
              const base = key.replace(/\.Name$/, "");
              return {
                media: kv[`${base}.Type`] || "video",
                mime: kv[`${base}.Encoding`] || null,
                state: "unknown",
                name: val || base,
              };
            });
          return streams;
        }
      } catch (_) {
        // ignore fallback errors
      }

      return {
        error: `HTTP ${res.status}`,
        detail: await res.text().catch(() => undefined),
      };
    }
    const json = await res.json();
    const list =
      json?.data?.stream ||
      json?.data?.streams ||
      json?.streams ||
      json?.data ||
      [];

    const normalized = list.map((s) => ({
      media: s.media || s.type || null,
      mime: s.mime || s.codec || null,
      state: s.state || s.status || null,
    }));

    // If camera returns nothing, surface the configured stream as a fallback hint
    if (normalized.length === 0 && CAM_URL) {
      normalized.push({
        media: "video",
        mime: null,
        state: "unknown",
        url: CAM_URL,
      });
    }
    return normalized;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "unknown error" };
  }
}

async function getTime() {
  try {
    const res = await fetchWithTimeout("/axis-cgi/time.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        apiVersion: "1.0",
        method: "getDateTimeInfo",
      }),
    });

    const body = await res.text();

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }

    if (!res.ok || json?.error) {
      return {
        cameraTime: null,
        timezone: null,
        error: json?.error?.message || `HTTP ${res.status} from time.cgi`,
      };
    }

    const data = json?.data || json || {};

    const cameraTime = data.localDateTime || data.dateTime || null;

    const timezone =
      data.timeZone || data.posixTimeZone || data.dhcpTimeZone || null;

    return {
      cameraTime,
      timezone,
    };
  } catch (err) {
    return {
      cameraTime: null,
      timezone: null,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

async function getDeviceInfo() {
  try {
    const res = await fetchWithTimeout(
      "/axis-cgi/param.cgi?action=list&group=Brand&group=Properties.Firmware&group=Properties.System",
      { headers: { Accept: "text/plain" } }
    );
    if (!res.ok) {
      // fallback to systeminfo.cgi (XML)
      const sysRes = await fetchWithTimeout("/axis-cgi/systeminfo.cgi", {
        headers: { Accept: "application/xml,text/xml" },
      });
      if (sysRes.ok) {
        const xml = await sysRes.text();
        const tag = (t) => {
          const m = xml.match(new RegExp(`<${t}>([^<]*)</${t}>`, "i"));
          return m ? m[1].trim() : null;
        };
        return {
          model: tag("prodname") || tag("model") || null,
        };
      }

      return {
        error: `HTTP ${res.status}`,
        detail: await res.text().catch(() => undefined),
      };
    }
    const text = await res.text();
    const kv = parseKvBody(text);
    return {
      model: kv["Brand.ProdFullName"] || kv["Brand.ProdShortName"] || null,
      firmware: kv["Properties.Firmware.Version"] || null,
      serial: kv["Properties.System.SerialNumber"] || null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "unknown error" };
  }
}

async function getPtzLimits() {
  try {
    const res = await fetchWithTimeout(
      "/axis-cgi/param.cgi?action=list&group=PTZ.Limit.L1",
      { headers: { Accept: "text/plain" } }
    );
    if (!res.ok) {
      return {
        minZoom: PTZ_MIN_ZOOM_DEFAULT,
        maxZoom: PTZ_MAX_ZOOM_DEFAULT,
        error: `HTTP ${res.status}`,
      };
    }

    const text = await res.text();
    const kv = parseKvBody(text);

    const toNumber = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    return {
      minZoom: toNumber(kv["PTZ.Limit.L1.MinZoom"], PTZ_MIN_ZOOM_DEFAULT),
      maxZoom: toNumber(kv["PTZ.Limit.L1.MaxZoom"], PTZ_MAX_ZOOM_DEFAULT),
      minPan: toNumber(kv["PTZ.Limit.L1.MinPan"], -172),
      maxPan: toNumber(kv["PTZ.Limit.L1.MaxPan"], 172),
      minTilt: toNumber(kv["PTZ.Limit.L1.MinTilt"], -172),
      maxTilt: toNumber(kv["PTZ.Limit.L1.MaxTilt"], 172),
    };
  } catch (err) {
    return {
      minZoom: PTZ_MIN_ZOOM_DEFAULT,
      maxZoom: PTZ_MAX_ZOOM_DEFAULT,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

function parseTemperaturePayload(payload) {
  const sensors = {};
  const heater = { status: null, timeUntilStop: null };

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
  };
}

async function getTemperatureAndIr() {
  try {
    const res = await fetchWithTimeout(
      "/axis-cgi/temperaturecontrol.cgi?action=statusall",
      { headers: { Accept: "text/plain" } }
    );
    if (!res.ok) {
      return {
        error: `HTTP ${res.status}`,
        detail: await res.text().catch(() => undefined),
      };
    }
    const text = await res.text();
    const parsed = parseTemperaturePayload(text);
    // Try IR state (best-effort)
    let irState = null;
    try {
      const irRes = await fetchWithTimeout(
        "/axis-cgi/ircutfilter.cgi?action=getircutfilter",
        { headers: { Accept: "text/plain" } }
      );
      if (irRes.ok) {
        const irText = await irRes.text();
        const kv = parseKvBody(irText);
        irState =
          kv["ircutfilter"] ||
          kv["ir_cut_filter"] ||
          kv["IrcutFilter"] ||
          irText.trim() ||
          null;
      }
    } catch (_) {
      // ignore IR errors
    }
    return {
      sensor: parsed.sensors[0]?.celsius ?? null,
      sensors: parsed.sensors,
      heater: parsed.heater,
      irState,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "unknown error" };
  }
}

async function sendPtzCommand(params) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `/axis-cgi/com/ptz.cgi${query ? `?${query}` : ""}`;
  return fetchWithTimeout(url, { method: "GET" });
}

app.get("/", (_req, res) => {
  res.send("apartment-cam proxy is running");
});

const statusCache = {
  data: null,
  expiresAt: 0,
  promise: null,
};

const capsCache = {
  data: null,
  expiresAt: 0,
  promise: null,
};

const VIEWER_HEARTBEAT_TTL_MS = 65 * 1000;
const viewerHeartbeats = new Map();
const TELEMETRY_PUSH_INTERVAL_MS = Number(
  process.env.TELEMETRY_PUSH_INTERVAL_MS || 20000
);
const VIEWER_STREAM_PING_MS = Number(
  process.env.VIEWER_STREAM_PING_MS || 15000
);

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function cleanupViewerHeartbeats() {
  const threshold = Date.now() - VIEWER_HEARTBEAT_TTL_MS;
  for (const [id, ts] of viewerHeartbeats.entries()) {
    if (ts < threshold) {
      viewerHeartbeats.delete(id);
    }
  }
}

function recordViewerHeartbeat(id) {
  if (!id) return;
  viewerHeartbeats.set(id, Date.now());
  cleanupViewerHeartbeats();
}

function getViewerCount() {
  cleanupViewerHeartbeats();
  return viewerHeartbeats.size;
}

app.get("/api/telemetry/stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const viewerId = typeof req.query?.id === "string" ? req.query.id : null;
  if (viewerId) {
    recordViewerHeartbeat(viewerId);
  }

  const sendViewerCount = () => {
    if (viewerId) {
      recordViewerHeartbeat(viewerId);
    }
    sendSse(res, "viewers", { count: getViewerCount() });
  };

  const sendStatus = async () => {
    try {
      const payload = await getCachedStatusPayload();
      sendSse(res, "status", payload);
    } catch (err) {
      sendSse(res, "status-error", {
        error: err instanceof Error ? err.message : "Failed to fetch status",
      });
    }
  };

  sendSse(res, "connected", { ok: true });
  void sendStatus();
  sendViewerCount();

  const heartbeatId = setInterval(sendViewerCount, VIEWER_STREAM_PING_MS);
  const statusId = setInterval(sendStatus, TELEMETRY_PUSH_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeatId);
    clearInterval(statusId);
    res.end();
  });
});

async function buildStatusPayload() {
  const [optics, geolocation, time, device, temperature] = await Promise.all([
    getPtzStatus(),
    getGeolocation(),
    getTime(),
    getDeviceInfo(),
    getTemperatureAndIr(),
  ]);

  return {
    optics,
    geolocation,
    time,
    device,
    temperature,
    fetchedAt: new Date().toISOString(),
  };
}

async function getCachedStatusPayload() {
  const now = Date.now();
  if (statusCache.data && now < statusCache.expiresAt) {
    return statusCache.data;
  }
  if (!statusCache.promise) {
    statusCache.promise = (async () => {
      try {
        const payload = await buildStatusPayload();
        statusCache.data = payload;
        statusCache.expiresAt = Date.now() + STATUS_CACHE_MS;
        return payload;
      } finally {
        statusCache.promise = null;
      }
    })();
  }
  return statusCache.promise;
}

async function getCachedCapabilities() {
  const now = Date.now();
  if (capsCache.data && now < capsCache.expiresAt) {
    return capsCache.data;
  }
  if (!capsCache.promise) {
    capsCache.promise = (async () => {
      try {
        const caps = await getPtzLimits();
        capsCache.data = caps;
        capsCache.expiresAt = Date.now() + CAPS_CACHE_MS;
        return caps;
      } finally {
        capsCache.promise = null;
      }
    })();
  }
  return capsCache.promise;
}

app.get("/api/status", async (_req, res) => {
  try {
    const payload = await getCachedStatusPayload();
    res.json(payload);
  } catch (err) {
    console.error("Status cache error", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to fetch status",
    });
  }
});

app.get("/api/ptz/status", async (_req, res) => {
  const camera = _req.query?.camera;
  const status = await getPtzStatus(camera);
  res.json(status);
});

app.get("/api/ptz/capabilities", async (_req, res) => {
  try {
    const caps = await getCachedCapabilities();
    res.json(caps);
  } catch (err) {
    console.error("Caps cache error", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to fetch capabilities",
    });
  }
});

app.post("/api/ptz", async (req, res) => {
  const { pan, tilt, zoom, camera } = req.body || {};
  const payload = {};
  if (camera !== undefined) {
    payload.camera = camera;
  }
  if (pan !== undefined) {
    const n = Number(pan);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "pan must be a number" });
      return;
    }
    payload.pan = n;
  }
  if (tilt !== undefined) {
    const n = Number(tilt);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "tilt must be a number" });
      return;
    }
    payload.tilt = n;
  }
  if (zoom !== undefined) {
    const n = Number(zoom);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "zoom must be a number" });
      return;
    }
    payload.zoom = Math.max(1, Math.min(9999, Math.round(n)));
  }

  if (!Object.keys(payload).length) {
    res.status(400).json({ error: "provide at least one of pan, tilt, zoom" });
    return;
  }

  try {
    const cameraRes = await sendPtzCommand(payload);
    if (!cameraRes.ok) {
      res
        .status(502)
        .json({ error: `Camera responded with ${cameraRes.status}` });
      return;
    }
    res.json({ success: true, applied: payload });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "unknown error" });
  }
});

app.post("/api/ptz/relative", async (req, res) => {
  const { pan, tilt, zoom, camera } = req.body || {};
  const payload = {};
  if (camera !== undefined) {
    payload.camera = camera;
  }
  if (pan !== undefined) {
    const n = Number(pan);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "pan must be a number" });
      return;
    }
    payload.rpan = Math.round(n);
  }
  if (tilt !== undefined) {
    const n = Number(tilt);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "tilt must be a number" });
      return;
    }
    payload.rtilt = Math.round(n);
  }
  if (zoom !== undefined) {
    const n = Number(zoom);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "zoom must be a number" });
      return;
    }
    payload.rzoom = Math.round(n);
  }

  if (!Object.keys(payload).length) {
    res.status(400).json({ error: "provide at least one of pan, tilt, zoom" });
    return;
  }

  try {
    const cameraRes = await sendPtzCommand(payload);
    if (!cameraRes.ok) {
      res
        .status(502)
        .json({ error: `Camera responded with ${cameraRes.status}` });
      return;
    }
    res.json({ success: true, applied: payload });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "unknown error" });
  }
});

app.post("/api/ptz/home", async (_req, res) => {
  try {
    const camera = _req.body?.camera;
    const cameraRes = await sendPtzCommand(
      camera ? { move: "home", camera } : { move: "home" }
    );
    if (!cameraRes.ok) {
      res
        .status(502)
        .json({ error: `Camera responded with ${cameraRes.status}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "unknown error" });
  }
});

app.post("/api/viewers/heartbeat", (req, res) => {
  const id = req.body?.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "viewer id required" });
    return;
  }
  recordViewerHeartbeat(id);
  res.json({ count: getViewerCount() });
});

app.get("/api/viewers", (_req, res) => {
  res.json({ count: getViewerCount() });
});

app.post("/api/zoom", async (req, res) => {
  const { magnification } = req.body || {};
  const magNumber = Number(magnification);
  if (!Number.isFinite(magNumber)) {
    res.status(400).json({ error: "magnification must be a number" });
    return;
  }

  const clamped = Math.max(1, Math.min(9999, Math.round(magNumber)));

  try {
    const cameraRes = await fetchWithTimeout(
      `/axis-cgi/com/ptz.cgi?zoom=${clamped}`,
      { method: "GET" }
    );
    if (!cameraRes.ok) {
      res
        .status(502)
        .json({ error: `Camera responded with ${cameraRes.status}` });
      return;
    }
    res.json({ success: true, zoom: clamped });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "unknown error" });
  }
});

app.post("/api/zoom/relative", async (req, res) => {
  const { delta } = req.body || {};
  const deltaNumber = Number(delta);
  if (!Number.isFinite(deltaNumber)) {
    res.status(400).json({ error: "delta must be a number" });
    return;
  }

  const step = Math.round(deltaNumber);

  try {
    const cameraRes = await fetchWithTimeout(
      `/axis-cgi/com/ptz.cgi?rzoom=${step}`,
      { method: "GET" }
    );
    if (!cameraRes.ok) {
      res
        .status(502)
        .json({ error: `Camera responded with ${cameraRes.status}` });
      return;
    }
    res.json({ success: true, step });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "unknown error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`apartment-cam proxy listening on port ${port}`);
});
