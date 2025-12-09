"use client";

import { useEffect, useRef, useState } from "react";

const LOCALHOST = false;
const DEFAULT_API_BASE = LOCALHOST
  ? "http://localhost:3001"
  : "https://cam.ebox86.com";
const DEFAULT_STREAM_URL = LOCALHOST
  ? "http://localhost:3001/stream"
  : "https://cam.ebox86.com/stream";
const DEFAULT_CAMERA_ID = 1;

function parseCameraId(value?: string | number | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CAMERA_ID;
}

type StatusResponse = {
  optics: {
    magnification: number | null;
    pan: number | null;
    tilt: number | null;
    raw?: string;
  };
  geolocation: {
    lat: number | null;
    lng: number | null;
    heading: number | null;
    valid?: boolean | null;
  };
  time: {
    cameraTime: string | null;
    timezone: string | null;
  };
  device: {
    model: string | null;
    firmware?: string | null;
    serial?: string | null;
  };
  temperature: {
    sensors: {
      id: string;
      name: string | null;
      celsius: number | null;
      fahrenheit: number | null;
    }[];
    heater: {
      status: string | null;
      timeUntilStop: number | null;
    };
  };
};

type PtzCaps = {
  minZoom: number;
  maxZoom: number;
  minPan?: number;
  maxPan?: number;
  minTilt?: number;
  maxTilt?: number;
};

type WeatherData = {
  tempC: number | null;
  description: string | null;
  humidity: number | null;
  windKph: number | null;
  icon: string | null;
};

type AppConfig = {
  apiBase: string;
  cameraId: number;
  streamUrl: string;
};

function formatLat(lat: number | null | undefined) {
  if (lat == null || Number.isNaN(lat)) return "—";
  const suffix = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(6)}° ${suffix}`;
}

function formatLng(lng: number | null | undefined) {
  if (lng == null || Number.isNaN(lng)) return "—";
  const suffix = lng >= 0 ? "E" : "W";
  return `${Math.abs(lng).toFixed(6)}° ${suffix}`;
}

function formatHeading(heading: number | null | undefined) {
  if (heading == null || Number.isNaN(heading)) return "—";
  return `${heading.toFixed(1)}°`;
}

function formatTemperature(sensorName: string, celsius: number | null) {
  if (celsius == null) return `${sensorName}: —`;
  return `${sensorName}: ${celsius.toFixed(1)}°C`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHeading(h: number) {
  const v = h % 360;
  return v < 0 ? v + 360 : v;
}

function titleCase(input: string | null | undefined) {
  if (!input) return "";
  return input
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function cToF(c: number | null | undefined) {
  if (c == null || Number.isNaN(c)) return null;
  return c * (9 / 5) + 32;
}

export default function ApartmentCamPage() {
  const camContainerRef = useRef<HTMLDivElement | null>(null);
  const hideHudTimer = useRef<NodeJS.Timeout | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);
  const [aimBox, setAimBox] = useState<{ x: number; y: number } | null>(null);
  const initialApiBase =
    process.env.NEXT_PUBLIC_PROXY_BASE ||
    process.env.PROXY_BASE ||
    DEFAULT_API_BASE;
  const initialCameraId = parseCameraId(
    process.env.NEXT_PUBLIC_CAMERA_ID || process.env.CAMERA_ID
  );
  const initialStreamUrl =
    process.env.NEXT_PUBLIC_STREAM_URL ||
    process.env.STREAM_URL ||
    DEFAULT_STREAM_URL;
  const [config, setConfig] = useState<AppConfig>({
    apiBase: initialApiBase,
    cameraId: initialCameraId,
    streamUrl: initialStreamUrl,
  });
  const cameraId = config.cameraId;
  const apiUrl = (path: string) => `${config.apiBase}${path}`;
  const streamUrl = config.streamUrl || DEFAULT_STREAM_URL;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [clock, setClock] = useState<string>("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [caps, setCaps] = useState<PtzCaps | null>(null);
  const [hudVisible, setHudVisible] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [targetZoom, setTargetZoom] = useState<number | null>(null);
  const [showHudOverlay, setShowHudOverlay] = useState(true);
  const [showReticle, setShowReticle] = useState(true);
  const [showHeadingOverlay, setShowHeadingOverlay] = useState(false);
  const [showPtzOverlay, setShowPtzOverlay] = useState(false);
  const [showTempOverlay, setShowTempOverlay] = useState(false);
  const [showZoomMeter, setShowZoomMeter] = useState(false);
  const [showWeatherOverlay, setShowWeatherOverlay] = useState(true);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadConfig = async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error(`Config HTTP ${res.status}`);
        const payload = (await res.json()) as Partial<AppConfig>;
        if (!active) return;
        setConfig((prev) => {
          const nextCameraId =
            payload.cameraId != null ? parseCameraId(payload.cameraId) : prev.cameraId;
          return {
            apiBase: payload.apiBase || prev.apiBase,
            cameraId: nextCameraId,
            streamUrl: payload.streamUrl || prev.streamUrl,
          };
        });
      } catch (err) {
        console.error("Failed to load runtime config", err);
      }
    };

    loadConfig();
    return () => {
      active = false;
    };
  }, []);

  // live clock with seconds
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setClock(
        now.toLocaleString(undefined, {
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    };

    updateClock();
    const id = setInterval(updateClock, 1000);
    return () => clearInterval(id);
  }, []);

  // fullscreen tracking
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  // camera telemetry polling
  useEffect(() => {
    let mounted = true;

    const fetchStatus = async () => {
      try {
        setLoadingStatus(true);
        const res = await fetch(apiUrl("/api/status"), { cache: "no-store" });
        if (!res.ok) throw new Error(`Status HTTP ${res.status}`);
        const data = (await res.json()) as StatusResponse;
        if (mounted) {
          setStatus(data);
          setApiError(null);
        }
      } catch (err) {
        if (mounted) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setApiError(message);
        }
      } finally {
        if (mounted) setLoadingStatus(false);
      }
    };

    const fetchCaps = async () => {
      try {
        const res = await fetch(apiUrl("/api/ptz/capabilities"), {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Caps HTTP ${res.status}`);
        const data = (await res.json()) as PtzCaps;
        if (mounted) setCaps(data);
      } catch {
        // keep defaults
      }
    };

    fetchStatus();
    fetchCaps();

    const statusId = setInterval(fetchStatus, 10000);
    return () => {
      mounted = false;
      clearInterval(statusId);
    };
  }, [config.apiBase]);

  // weather fetch (OpenWeather)
  useEffect(() => {
    const lat = status?.geolocation.lat;
    const lng = status?.geolocation.lng;
    if (lat == null || lng == null) return;

    const controller = new AbortController();
    const fetchWeather = async () => {
      try {
        const res = await fetch(`/api/weather?lat=${lat}&lng=${lng}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
        const json = await res.json();
        setWeather({
          tempC: json?.tempC ?? null,
          description: titleCase(json?.description ?? ""),
          humidity: json?.humidity ?? null,
          windKph: json?.windKph ?? null,
          icon: json?.icon ?? null,
        });
        setWeatherError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setWeather(null);
        setWeatherError(
          err instanceof Error ? err.message : "Failed to load weather"
        );
      }
    };

    fetchWeather();
    const refresh = setInterval(fetchWeather, 5 * 60 * 1000);
    return () => {
      controller.abort();
      clearInterval(refresh);
    };
  }, [status?.geolocation.lat, status?.geolocation.lng]);

  const handleFullscreen = async () => {
    try {
      if (!document.fullscreenElement && camContainerRef.current) {
        await camContainerRef.current.requestFullscreen();
      } else if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen error", err);
    }
  };

  const handleExpand = () => setIsExpanded((prev) => !prev);

  const currentLat = status?.geolocation.lat ?? null;
  const currentLng = status?.geolocation.lng ?? null;
  const currentHeadingRaw = status?.geolocation.heading ?? null;
  const currentHeading =
    currentHeadingRaw != null ? normalizeHeading(currentHeadingRaw) : null;
  const zoomMin = caps?.minZoom ?? 1;
  const zoomMax = caps?.maxZoom ?? 9999;
  const currentZoom = status?.optics.magnification ?? zoomMin;
  const zoomPercent =
    ((currentZoom - zoomMin) / (zoomMax - zoomMin || 1)) * 100;

  const showHud = () => {
    setHudVisible(true);
    if (hideHudTimer.current) clearTimeout(hideHudTimer.current);
    hideHudTimer.current = setTimeout(() => setHudVisible(false), 3000);
  };

  useEffect(() => {
    const container = camContainerRef.current;
    if (!container) return;
    const handleMove = () => showHud();
    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mouseenter", handleMove);
    container.addEventListener("mouseleave", handleMove);
    return () => {
      container.removeEventListener("mousemove", handleMove);
      container.removeEventListener("mouseenter", handleMove);
      container.removeEventListener("mouseleave", handleMove);
    };
  }, []);

  const applyZoom = async (zoomValue: number) => {
    const z = clamp(Math.round(zoomValue), zoomMin, zoomMax);
    try {
      await fetch(apiUrl("/api/ptz"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoom: z, camera: cameraId }),
      });
      setStatus((prev) =>
        prev
          ? { ...prev, optics: { ...prev.optics, magnification: z } }
          : prev
      );
    } catch (err) {
      console.error("Zoom error", err);
    }
  };

  const applyRelativeZoom = async (delta: number) => {
    try {
      await fetch(apiUrl("/api/ptz/relative"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoom: delta, camera: cameraId }),
      });
    } catch (err) {
      console.error("Relative zoom error", err);
    }
  };

  const applyRelativePanTilt = async (panDelta: number, tiltDelta: number) => {
    const payload: Record<string, number | string> = { camera: cameraId };
    if (panDelta) payload.pan = Math.round(panDelta);
    if (tiltDelta) payload.tilt = Math.round(tiltDelta);
    if (!payload.pan && !payload.tilt) return;
    try {
      await fetch(apiUrl("/api/ptz/relative"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Relative pan/tilt error", err);
    }
  };

  const goHome = async () => {
    try {
      await fetch(apiUrl("/api/ptz/home"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera: cameraId }),
      });
    } catch (err) {
      console.error("Home error", err);
    }
  };

  const handleWheelZoom = (e: React.WheelEvent) => {
    e.preventDefault();
    const baseZoom = targetZoom ?? currentZoom ?? zoomMin;
    const step = Math.max(50, (zoomMax - zoomMin) / 40);
    const next = clamp(
      baseZoom + (e.deltaY < 0 ? step : -step),
      zoomMin,
      zoomMax
    );
    setTargetZoom(next);
  };

  const handleClickPanZoom = (clientX: number, clientY: number) => {
    if (!camContainerRef.current) return;
    const rect = camContainerRef.current.getBoundingClientRect();
    setAimBox({ x: clientX - rect.left, y: clientY - rect.top });
    const relX = (clientX - rect.left) / rect.width - 0.5;
    const relY = (clientY - rect.top) / rect.height - 0.5;
    const panRange =
      caps && caps.maxPan != null && caps.minPan != null
        ? caps.maxPan - caps.minPan
        : 200;
    const tiltRange =
      caps && caps.maxTilt != null && caps.minTilt != null
        ? caps.maxTilt - caps.minTilt
        : 100;
    const panDelta = relX * (panRange / 3);
    const tiltDelta = -relY * (tiltRange / 3);
    const z = targetZoom ?? currentZoom ?? zoomMin;
    applyZoom(z);
    applyRelativePanTilt(panDelta, tiltDelta);
  };

  return (
    <div className="app-root">
      {/* Fixed top bar */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-logo">
            <img
              src="/logo.png"
              alt="Apartment Cam Logo"
              width={70}
              height={70}
            />
          </div>
          <div className="top-bar-text">
            <div className="top-bar-title">APARTMENT-CAM // PITTSBURGH, PA</div>
            <div className="top-bar-subtitle">
              High-rise MJPEG viewer · PTZ + telemetry
            </div>
          </div>
        </div>
        <div className="top-bar-right">
          <span className="meta-label">LOCAL</span>
          <span className="meta-value meta-mono">
            {clock || "----/--/-- --:--:--"}
          </span>
          <span className="flag-avatar" title="USA">
            🇺🇸
          </span>
        </div>
      </header>

      {/* Centered camera pane */}
      <main className="center-shell">
        <div className="layout-grid">
        <section className={`cam-panel ${isExpanded ? "cam-panel-expanded" : ""}`}>
          <div
            ref={camContainerRef}
            className={`cam-frame ${hudVisible ? "" : "hud-hidden"}`}
            onMouseDown={(e) => {
              dragStart.current = { x: e.clientX, y: e.clientY };
              dragMoved.current = false;
              if (camContainerRef.current) {
                const rect = camContainerRef.current.getBoundingClientRect();
                setAimBox({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              }
              showHud();
            }}
            onMouseUp={(e) => {
              if (!dragStart.current || !camContainerRef.current) return;
              const dx = e.clientX - dragStart.current.x;
              const dy = e.clientY - dragStart.current.y;
              const rect = camContainerRef.current.getBoundingClientRect();
              const panRange =
                caps && caps.maxPan != null && caps.minPan != null
                  ? caps.maxPan - caps.minPan
                  : 200;
              const tiltRange =
                caps && caps.maxTilt != null && caps.minTilt != null
                  ? caps.maxTilt - caps.minTilt
                  : 100;
              const panDelta = (dx / rect.width) * (panRange / 4);
              const tiltDelta = (-dy / rect.height) * (tiltRange / 4);

              if (
                Math.abs(panDelta) > 2 ||
                Math.abs(tiltDelta) > 2 ||
                dragMoved.current
              ) {
                applyRelativePanTilt(panDelta, tiltDelta);
              } else {
                handleClickPanZoom(e.clientX, e.clientY);
              }

              dragStart.current = null;
              dragMoved.current = false;
            }}
            onMouseMove={(e) => {
              if (!dragStart.current) return;
              if (
                Math.abs(e.clientX - dragStart.current.x) > 4 ||
                Math.abs(e.clientY - dragStart.current.y) > 4
              ) {
                dragMoved.current = true;
              }
            }}
            onMouseLeave={() => {
              dragStart.current = null;
              dragMoved.current = false;
              setAimBox(null);
            }}
            onWheel={handleWheelZoom}
          >
            <div className="cam-frame-inner">
              {!hasError ? (
                <img
                  src={streamUrl}
                  alt="Pittsburgh skyline live camera"
                  onError={() => setHasError(true)}
                />
              ) : (
                <div className="cam-offline">
                  <span>STREAM OFFLINE / UNREACHABLE</span>
                </div>
              )}
            </div>
            {showReticle && (targetZoom || aimBox) && (
              <div
                className="cam-aim-box"
                style={
                  aimBox && camContainerRef.current
                    ? {
                        left: `${aimBox.x}px`,
                        top: `${aimBox.y}px`,
                        transform: "translate(-50%, -50%)",
                        position: "absolute",
                      }
                    : {}
                }
              >
                <div className="cam-aim-inner" />
              </div>
            )}

            {/* Heading overlay */}
            {showHeadingOverlay && currentHeading != null && (
              <div className="heading-overlay">
                <div className="heading-arc" />
                {[ -60, -30, 0, 30, 60 ].map((offset) => {
                  const h = normalizeHeading(currentHeading + offset);
                  const label =
                    h === 0
                      ? "N"
                      : h === 90
                      ? "E"
                      : h === 180
                      ? "S"
                      : h === 270
                      ? "W"
                      : `${Math.round(h)}`;
                  return (
                    <div
                      key={offset}
                      className={`heading-line ${
                        offset === 0 ? "heading-line-active" : ""
                      }`}
                      style={{ left: `${50 + offset * 0.8}%` }}
                    >
                      <span className="heading-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* HUD overlay (minimal) */}
            {showHudOverlay && (
              <div className="cam-hud cam-hud-minimal">
                <div className="cam-hud-top">
                  <span>PITTSBURGH, PA · APARTMENT-CAM</span>
                  <span>
                    <span className="status-dot" />
                    MJPEG · <span className="live-pill">LIVE</span>
                  </span>
                </div>
              </div>
            )}

            {/* Quick overlays */}
            {showPtzOverlay && (
              <div className="overlay-pill overlay-ptz">
                PTZ P {status?.optics.pan ?? "—"} · T {status?.optics.tilt ?? "—"} ·
                Z {currentZoom ?? "—"}
              </div>
            )}
            {showTempOverlay && (
              <div className="overlay-pill overlay-temp">
                Temp {status?.temperature?.sensors?.[0]?.celsius?.toFixed(1) ?? "—"}°C ·
                PCB {status?.temperature?.sensors?.[1]?.celsius?.toFixed(1) ?? "—"}°C
              </div>
            )}
            {showZoomMeter && (
              <div className="zoom-mini">
                <div className="zoom-mini-track">
                  <div
                    className="zoom-mini-fill"
                    style={{ height: `${Math.max(0, Math.min(100, zoomPercent))}%` }}
                  />
                </div>
                <div className="zoom-mini-label">Z {currentZoom ?? "—"}</div>
              </div>
            )}
            {showWeatherOverlay && weather && (
              <div className="overlay-weather">
                {weather.icon && (
                  <img
                    src={`https://openweathermap.org/img/wn/${weather.icon}@2x.png`}
                    alt={weather.description || "Weather"}
                    className="weather-icon"
                  />
                )}
                <div className="weather-meta">
                  <div className="weather-temp">
                    {(() => {
                      const f = cToF(weather.tempC);
                      return f != null ? `${Math.round(f)}°F` : "—";
                    })()}
                  </div>
                  <div className="weather-desc">
                    {weather.description || "Weather unavailable"}
                  </div>
                  <div className="weather-sub">
                    Humidity {weather.humidity ?? "—"}% · Wind{" "}
                    {weather.windKph != null
                      ? `${(weather.windKph / 1.609).toFixed(1)} mph`
                      : "—"}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* footer under cam */}
          <div className="cam-footer">
            <div className="cam-footer-left meta-mono">
              {status?.device.model || "Pittsburgh · Pennsylvania · USA"}
            </div>
            <div className="cam-footer-right cam-footer-actions">
              <button className="btn" type="button" onClick={handleExpand}>
                {isExpanded ? "Collapse" : "Expand"}
              </button>
              <button className="btn" type="button" onClick={handleFullscreen}>
                {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              </button>
            </div>
          </div>

          {/* telemetry + controls */}
          <div className="cam-controls-grid">
            <div className="stats-panel">
              <div className="stats-grid">
                <div className="stats-item">
                  <div className="stats-label">LOCATION</div>
                  <div className="stats-value">
                    {status?.geolocation
                      ? "Pittsburgh, Pennsylvania, USA"
                      : "—"}
                  </div>
                </div>
                <div className="stats-item">
                  <div className="stats-label">COORDINATES</div>
                  <div className="stats-value meta-mono">
                    {formatLat(currentLat)} / {formatLng(currentLng)}
                  </div>
                </div>
                <div className="stats-item">
                  <div className="stats-label">HEADING</div>
                  <div className="stats-value meta-mono">
                    {formatHeading(currentHeading)}
                  </div>
                </div>
                <div className="stats-item">
                  <div className="stats-label">WEATHER</div>
                  <div className="stats-value">
                    {weather
                      ? `${(() => {
                          const f = cToF(weather.tempC);
                          return f != null ? Math.round(f) : "—";
                        })()}°F · ${weather.description || "—"}`
                      : "—"}
                  </div>
                  {weather ? (
                    <div className="app-subtitle">
                      Humidity {weather.humidity ?? "—"}% · Wind{" "}
                      {weather.windKph != null
                        ? `${(weather.windKph / 1.609).toFixed(1)} mph`
                        : "—"}
                    </div>
                  ) : null}
                  {weatherError && (
                    <div className="app-subtitle">Weather error: {weatherError}</div>
                  )}
                </div>
                <div className="stats-item">
                  <div className="stats-label">TIME</div>
                  <div className="stats-value meta-mono">
                    {status?.time.cameraTime || "—"}
                  </div>
                  {status?.time.timezone && (
                    <div className="app-subtitle">{status.time.timezone}</div>
                  )}
                </div>
                <div className="stats-item">
                  <div className="stats-label">TEMPERATURES</div>
                  <div className="stats-value meta-mono">
                    {status?.temperature
                      ? status.temperature.sensors
                          .map((sensor) =>
                            formatTemperature(
                              sensor.name || sensor.id,
                              sensor.celsius
                            )
                          )
                          .join(" · ")
                      : "—"}
                  </div>
                </div>
                <div className="stats-item">
                  <div className="stats-label">HEATER</div>
                  <div className="stats-value meta-mono">
                    {status?.temperature
                      ? `${status.temperature.heater.status ?? "Unknown"}${
                          status.temperature.heater.timeUntilStop != null
                            ? ` · ${status.temperature.heater.timeUntilStop}s`
                            : ""
                        }`
                      : "—"}
                  </div>
                </div>
                <div className="stats-item">
                  <div className="stats-label">PTZ</div>
                  <div className="stats-value meta-mono">
                    Zoom {currentZoom ?? "—"}
                  </div>
                  <div className="stats-value meta-mono">
                    Pan {status?.optics.pan ?? "—"} · Tilt{" "}
                    {status?.optics.tilt ?? "—"}
                  </div>
                  {loadingStatus && <div className="app-subtitle">Refreshing…</div>}
                  {apiError && (
                    <div className="app-subtitle">Error: {apiError}</div>
                  )}
                </div>
              </div>
            </div>

            <div className="ptz-panel">
              <div className="ptz-header">
                <div className="stats-label">ZOOM CONTROL</div>
                <div className="app-subtitle">
                  Camera {cameraId} ({zoomMin}–{zoomMax})
                </div>
              </div>
              <div className="ptz-body">
                <div className="ptz-buttons">
                  <button
                    className="btn"
                    onClick={() => applyRelativeZoom(-200)}
                    type="button"
                  >
                    Zoom Out
                  </button>
                  <button
                    className="btn"
                    onClick={() => applyZoom(zoomMin)}
                    type="button"
                  >
                    Min
                  </button>
                  <button
                    className="btn"
                    onClick={() => applyZoom(zoomMax)}
                    type="button"
                  >
                    Max
                  </button>
                  <button
                    className="btn"
                    onClick={() => applyRelativeZoom(200)}
                    type="button"
                  >
                    Zoom In
                  </button>
                  <button className="btn" onClick={goHome} type="button">
                    Home / Reset
                  </button>
                </div>

                <div className="ptz-arrows">
                  <button
                    className="btn ptz-arrow ptz-arrow-up"
                    onClick={() => applyRelativePanTilt(0, 10)}
                    type="button"
                  >
                    ▲
                  </button>
                  <button
                    className="btn ptz-arrow ptz-arrow-left"
                    onClick={() => applyRelativePanTilt(-10, 0)}
                    type="button"
                  >
                    ◀
                  </button>
                  <button
                    className="btn ptz-arrow ptz-arrow-home"
                    onClick={goHome}
                    type="button"
                  >
                    Home
                  </button>
                  <button
                    className="btn ptz-arrow ptz-arrow-right"
                    onClick={() => applyRelativePanTilt(10, 0)}
                    type="button"
                  >
                    ▶
                  </button>
                  <button
                    className="btn ptz-arrow ptz-arrow-down"
                    onClick={() => applyRelativePanTilt(0, -10)}
                    type="button"
                  >
                    ▼
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <aside className="layer-panel">
          <div className="layer-header">
            <div className="stats-label">Layers</div>
            <div className="app-subtitle">Overlays & reticle</div>
          </div>
          <div className="layer-list">
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showHudOverlay}
                onChange={(e) => setShowHudOverlay(e.target.checked)}
              />
              <span>HUD overlay</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showReticle}
                onChange={(e) => setShowReticle(e.target.checked)}
              />
              <span>Reticle / aim box</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showHeadingOverlay}
                onChange={(e) => setShowHeadingOverlay(e.target.checked)}
              />
              <span>Heading arc</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showPtzOverlay}
                onChange={(e) => setShowPtzOverlay(e.target.checked)}
              />
              <span>PTZ readout</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showTempOverlay}
                onChange={(e) => setShowTempOverlay(e.target.checked)}
              />
              <span>Temperature readout</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showZoomMeter}
                onChange={(e) => setShowZoomMeter(e.target.checked)}
              />
              <span>Zoom meter</span>
            </label>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={showWeatherOverlay}
                onChange={(e) => setShowWeatherOverlay(e.target.checked)}
              />
              <span>Weather overlay</span>
            </label>
          </div>
        </aside>
        </div>
      </main>
    </div>
  );
}
