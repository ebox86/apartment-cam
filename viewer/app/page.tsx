"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { siteConfig } from "../config/site-config";

const LOCALHOST = process.env.NODE_ENV === "development";
const DEFAULT_API_BASE = LOCALHOST
  ? "http://localhost:3001"
  : "https://cam.ebox86.com";
const DEFAULT_STREAM_URL = LOCALHOST
  ? "http://localhost:3001/stream"
  : "https://cam.ebox86.com/stream";
const DEFAULT_CAMERA_ID = 1;
const STREAM_OFFLINE_LABEL = "STREAM OFFLINE";

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

const countryNameFormatter =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function formatCountryName(code?: string | null) {
  if (!code) return null;
  const normalized = code.toUpperCase();
  if (countryNameFormatter) {
    const resolved = countryNameFormatter.of(normalized);
    if (resolved) return resolved;
  }
  return normalized;
}

function buildLocationLabel(
  city?: string | null,
  region?: string | null,
  country?: string | null
) {
  const parts: string[] = [];
  if (city) parts.push(city);
  if (region) parts.push(region);
  const countryName = formatCountryName(country);
  if (countryName) parts.push(countryName);
  return parts.join(", ");
}

function countryCodeToFlag(code?: string | null) {
  if (!code) return "🏳️";
  const normalized = code.toUpperCase();
  if (normalized.length !== 2) return "🏳️";
  const base = 0x1f1e6;
  const first = normalized.charCodeAt(0);
  const second = normalized.charCodeAt(1);
  if (
    first < 65 ||
    first > 90 ||
    second < 65 ||
    second > 90
  ) {
    return "🏳️";
  }
  return String.fromCodePoint(base + first - 65, base + second - 65);
}

const FULLSCREEN_CHANGE_EVENTS = [
  "fullscreenchange",
  "webkitfullscreenchange",
  "mozfullscreenchange",
  "MSFullscreenChange",
] as const;

function getActiveFullscreenElement() {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
    msFullscreenElement?: Element | null;
  };
  return (
    doc.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.mozFullScreenElement ??
    doc.msFullscreenElement ??
    null
  );
}

function runVendorMethod(
  target: Record<string, unknown>,
  methodNames: string[]
): ((...args: any[]) => any) | null {
  for (const method of methodNames) {
    const candidate = target[method];
    if (typeof candidate === "function") {
      return candidate as (...args: any[]) => any;
    }
  }
  return null;
}

async function enterFullscreen(element: Element) {
  const method = runVendorMethod(
    element as unknown as Record<string, unknown>,
    [
      "requestFullscreen",
      "webkitRequestFullscreen",
    "mozRequestFullScreen",
    "msRequestFullscreen",
  ]);
  if (!method) return false;
  await method.call(element);
  return true;
}

async function exitFullscreen() {
  const method = runVendorMethod(
    document as unknown as Record<string, unknown>,
    [
      "exitFullscreen",
    "webkitExitFullscreen",
    "mozCancelFullScreen",
    "msExitFullscreen",
  ]);
  if (!method) return false;
  await method.call(document);
  return true;
}

export default function ApartmentCamPage() {
  const camContainerRef = useRef<HTMLDivElement | null>(null);
  const camInnerRef = useRef<HTMLDivElement | null>(null);
  const hideHudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const zoomHoldRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tvCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamProbeController = useRef<AbortController | null>(null);
  const [aimBox, setAimBox] = useState<{ x: number; y: number } | null>(null);
  const [dragMoved, setDragMoved] = useState(false);
  const [panLine, setPanLine] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);
  const wheelIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wheelZoomIndicator, setWheelZoomIndicator] = useState<number | null>(
    null
  );
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
  const trimmedApiBase = config.apiBase
    ? config.apiBase.replace(/\/$/, "")
    : "";
  const streamProbeTarget = trimmedApiBase
    ? `${trimmedApiBase}/stream`
    : streamUrl;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [clock, setClock] = useState<string>("");
  const [utcClock, setUtcClock] = useState<string>("");
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
  const [showWeatherOverlay, setShowWeatherOverlay] = useState(false);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [locationLabelValue, setLocationLabelValue] = useState(
    siteConfig.locationLabel
  );
  const [titleLocationValue, setTitleLocationValue] = useState(
    siteConfig.siteTitleLocationFallback
  );
  const [countryCode, setCountryCode] = useState<string | null>(
    siteConfig.defaultCountryCode
  );
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState("");
  const [streamIssueDetail, setStreamIssueDetail] = useState<string | null>(
    null
  );
  const [isMobile, setIsMobile] = useState(false);
  const [streamCardCollapsed, setStreamCardCollapsed] = useState(false);
  const [camCollapsed, setCamCollapsed] = useState(false);

  const getPanTiltRange = () => {
    const panRange =
      caps && caps.maxPan != null && caps.minPan != null
        ? caps.maxPan - caps.minPan
        : 200;
    const tiltRange =
      caps && caps.maxTilt != null && caps.minTilt != null
        ? caps.maxTilt - caps.minTilt
        : 100;
    return { panRange, tiltRange };
  };

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

  useEffect(() => {
    if (typeof window !== "undefined") {
      setViewerUrl(window.location.href);
    }
  }, []);

  useEffect(() => {
    if (!shareStatus) return;
    const id = globalThis.setTimeout(() => setShareStatus(null), 2200);
    return () => {
      globalThis.clearTimeout(id);
    };
  }, [shareStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(query.matches);
    update();
    const listener = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    }
    if (typeof query.addListener === "function") {
      query.addListener(listener);
      return () => query.removeListener(listener);
    }
    return undefined;
  }, []);

  useEffect(() => {
    return () => {
      if (wheelIndicatorTimer.current) {
        globalThis.clearTimeout(wheelIndicatorTimer.current);
        wheelIndicatorTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      streamProbeController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isMobile) {
      setIsExpanded(true);
    }
  }, [isMobile]);

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
      setUtcClock(
        now.toLocaleString(undefined, {
          hour12: false,
          timeZone: "UTC",
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
      setIsFullscreen(Boolean(getActiveFullscreenElement()));
    };
    FULLSCREEN_CHANGE_EVENTS.forEach((eventName) =>
      document.addEventListener(eventName, handleFsChange)
    );
    return () => {
      FULLSCREEN_CHANGE_EVENTS.forEach((eventName) =>
        document.removeEventListener(eventName, handleFsChange)
      );
    };
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

    const statusId = setInterval(fetchStatus, 20000);
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
        const cityRaw = json?.name ?? null;
        const regionRaw =
          json?.state ?? json?.sys?.state ?? json?.sys?.region ?? null;
        const city = cityRaw ? titleCase(cityRaw) : null;
        const region = regionRaw ? titleCase(regionRaw) : null;
        const countryRaw = json?.sys?.country ?? null;
        const label = buildLocationLabel(city, region, countryRaw);
        if (label) {
          setLocationLabelValue(label);
        }
        if (city) {
          setTitleLocationValue(city);
        }
        if (countryRaw) {
          setCountryCode(countryRaw.toUpperCase());
        }
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
      const activeElement = getActiveFullscreenElement();
      if (!activeElement && camContainerRef.current) {
        await enterFullscreen(camContainerRef.current);
      } else {
        await exitFullscreen();
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
  const zoomAtExtremeOut =
    caps && caps.minZoom != null ? currentZoom <= caps.minZoom : false;
  const reticleActive =
    showReticle && !hasError && !loadingStatus && !zoomAtExtremeOut && !isMobile;
  const locationTitle = titleLocationValue || siteConfig.siteTitleLocationFallback;
  const topBarTitle = isMobile
    ? siteConfig.siteTitle
    : `${siteConfig.siteTitlePrefix}${locationTitle}`;
  const controlsDisabled = hasError;
  const locationDisplayValue =
    status?.geolocation && locationLabelValue ? locationLabelValue : "—";
  const countryName = formatCountryName(countryCode);
  const flagEmoji = countryCodeToFlag(countryCode);
  const offlineStatusLabel = STREAM_OFFLINE_LABEL;
  const offlineDetailText = streamIssueDetail;
  const overlaysEnabled = !hasError && !isMobile;
  const ptzPanelClassName = `ptz-panel${controlsDisabled ? " ptz-panel--disabled" : ""}`;
  const sharePanelClassName = `share-panel${controlsDisabled ? " share-panel--disabled" : ""}`;

  const showHud = () => {
    setHudVisible(true);
    if (hideHudTimer.current) clearTimeout(hideHudTimer.current);
    hideHudTimer.current = setTimeout(() => setHudVisible(false), 3000);
  };

  const toggleStreamCard = () => {
    setStreamCardCollapsed((prev) => !prev);
  };

  const toggleCamCollapse = () => {
    setCamCollapsed((prev) => !prev);
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
      if (hasError) {
        console.warn("Skip zoom while stream is offline");
        return;
      }
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
      if (hasError) {
        console.warn("Skip relative zoom while stream is offline");
        return;
      }
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
      if (hasError) {
        console.warn("Skip pan/tilt while stream is offline");
        return;
      }
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
      if (hasError) {
        console.warn("Skip go home while stream is offline");
        return;
      }
      await fetch(apiUrl("/api/ptz/home"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera: cameraId }),
      });
    } catch (err) {
      console.error("Home error", err);
    }
  };

  const handleWheelZoom = useCallback(
    (event: WheelEvent) => {
      if (hasError || loadingStatus) return;
      event.preventDefault();
      const baseZoom = targetZoom ?? currentZoom ?? zoomMin;
      const step = Math.max(50, (zoomMax - zoomMin) / 40);
      const next = clamp(
        baseZoom + (event.deltaY < 0 ? step : -step),
        zoomMin,
        zoomMax
      );
      setTargetZoom(next);
      setWheelZoomIndicator(
        zoomMax - zoomMin > 0 ? (next - zoomMin) / (zoomMax - zoomMin) : 0
      );
      if (wheelIndicatorTimer.current) {
        globalThis.clearTimeout(wheelIndicatorTimer.current);
      }
      wheelIndicatorTimer.current = globalThis.setTimeout(() => {
        setWheelZoomIndicator(null);
        wheelIndicatorTimer.current = null;
      }, 800);
      applyZoom(next);
    },
    [
      hasError,
      loadingStatus,
      targetZoom,
      currentZoom,
      zoomMin,
      zoomMax,
      applyZoom,
    ]
  );

  useEffect(() => {
    const container = camContainerRef.current;
    if (!container) return;
    const handler = (event: WheelEvent) => handleWheelZoom(event);
    container.addEventListener("wheel", handler, { passive: false });
    return () => {
      container.removeEventListener("wheel", handler);
    };
  }, [handleWheelZoom]);

  useEffect(() => {
    if (!hasError) return undefined;
    const canvas = tvCanvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const scaleFactor = 2.5;
    const FPS = 50;
    const scanSpeed = FPS * 15;
    const SAMPLE_COUNT = 10;
    let samples: ImageData[] = [];
    let sampleIndex = 0;
    let scanOffsetY = 0;
    let scanSize = 0;
    let animationFrameId: number;

    const interpolate = (
      x: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number
    ) => {
      if (x1 === x0) return y0;
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
    };

    const generateRandomSample = (w: number, h: number) => {
      const intensity: number[] = [];
      const factor = h / 50;
      const trans = 1 - Math.random() * 0.05;
      const intensityCurve: number[] = [];
      const steps = Math.floor(h / factor) + Math.floor(factor);
      for (let i = 0; i <= steps + 1; i++) {
        intensityCurve.push(Math.floor(Math.random() * 15));
      }
      for (let i = 0; i < h; i++) {
        const idx = Math.floor(i / factor);
        const nextIdx = Math.min(idx + 1, intensityCurve.length - 1);
        const value = interpolate(
          i / factor,
          idx,
          intensityCurve[idx],
          nextIdx,
          intensityCurve[nextIdx]
        );
        intensity.push(value);
      }
      const imageData = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const k = i * 4;
        let color = Math.floor(36 * Math.random());
        color += intensity[Math.floor(i / w)] ?? 0;
        const normalized = Math.max(0, Math.min(255, Math.round(color)));
        imageData.data[k] = imageData.data[k + 1] = imageData.data[k + 2] = normalized;
        imageData.data[k + 3] = Math.round(255 * trans);
      }
      return imageData;
    };

    const resize = () => {
      const width = Math.max(1, Math.floor(canvas.offsetWidth / scaleFactor));
      const height = Math.max(1, Math.floor(canvas.offsetHeight / scaleFactor));
      canvas.width = width;
      canvas.height = height;
      scanSize = Math.max(1, canvas.height / 3);
      samples = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        samples.push(generateRandomSample(canvas.width, canvas.height));
      }
      sampleIndex = 0;
      scanOffsetY = 0;
    };

    const handleResize = () => resize();
    window.addEventListener("resize", handleResize);
    resize();

    const render = () => {
      if (!samples.length) {
        animationFrameId = window.requestAnimationFrame(render);
        return;
      }
      const index = Math.floor(sampleIndex) % samples.length;
      ctx.putImageData(samples[index], 0, 0);
      sampleIndex += 20 / FPS;
      if (sampleIndex >= samples.length) sampleIndex = 0;

      const gradient = ctx.createLinearGradient(0, scanOffsetY, 0, scanOffsetY + scanSize);
      gradient.addColorStop(0, "rgba(255,255,255,0)");
      gradient.addColorStop(0.1, "rgba(255,255,255,0)");
      gradient.addColorStop(0.2, "rgba(255,255,255,0.2)");
      gradient.addColorStop(0.3, "rgba(255,255,255,0)");
      gradient.addColorStop(0.45, "rgba(255,255,255,0.1)");
      gradient.addColorStop(0.5, "rgba(255,255,255,1.0)");
      gradient.addColorStop(0.55, "rgba(255,255,255,0.55)");
      gradient.addColorStop(0.6, "rgba(255,255,255,0.25)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");

      const prevComposite = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = gradient;
      ctx.fillRect(0, scanOffsetY, canvas.width, scanSize + scanOffsetY);
      ctx.globalCompositeOperation = prevComposite;

      scanOffsetY += canvas.height / scanSpeed;
      if (scanOffsetY > canvas.height) scanOffsetY = -(scanSize / 2);

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [hasError, streamUrl]);

  const handleStreamLoad = () => {
    setHasError(false);
    setStreamIssueDetail(null);
    if (streamProbeController.current) {
      streamProbeController.current.abort();
      streamProbeController.current = null;
    }
  };

  const handleStreamError = () => {
    setHasError(true);
    void probeStreamEndpoint();
  };

  const probeStreamEndpoint = useCallback(async () => {
    if (!streamProbeTarget) return true;
    streamProbeController.current?.abort();
    const controller = new AbortController();
    streamProbeController.current = controller;

    const markOffline = (detail?: string) => {
      setStreamIssueDetail(detail ?? null);
      return false;
    };

    try {
      let res = await fetch(streamProbeTarget, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return true;

      if (res.status === 404 || res.status === 0) {
        res.body?.cancel?.();
        return markOffline(res.status === 404 ? "Stream not available" : undefined);
      }

      if (res.status === 405) {
        res.body?.cancel?.();
        res = await fetch(streamProbeTarget, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return true;
        if (res.status === 404 || !res.ok) {
          res.body?.cancel?.();
          return markOffline(res.status === 404 ? "Stream not available" : undefined);
        }
        res.body?.cancel?.();
        return true;
      }

      if (res.ok) {
        res.body?.cancel?.();
        return true;
      }

      res.body?.cancel?.();
      return markOffline();
    } catch (err) {
      if (controller.signal.aborted) return true;
      return markOffline();
    } finally {
      if (streamProbeController.current === controller) {
        streamProbeController.current = null;
      }
    }
  }, [streamProbeTarget]);

  useEffect(() => {
    if (!streamProbeTarget) return undefined;
    let active = true;

    const checkStream = async () => {
      const online = await probeStreamEndpoint();
      if (!active) return;
      if (online) setStreamIssueDetail(null);
      setHasError(!online);
    };

    void checkStream();
    const intervalId = globalThis.setInterval(() => {
      void checkStream();
    }, 15000);

    return () => {
      active = false;
      globalThis.clearInterval(intervalId);
    };
  }, [streamProbeTarget, probeStreamEndpoint]);

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

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) {
      setShareStatus(`${label} unavailable`);
      return;
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setShareStatus(`${label} copied`);
    } catch (err) {
      console.error("Clipboard copy failed", err);
      setShareStatus(`Failed to copy ${label}`);
    }
  };

  const handleNativeShare = async () => {
    if (!viewerUrl) {
      setShareStatus("Viewer URL unavailable");
      return;
    }
    if (!navigator?.share) {
      setShareStatus("Native share unsupported");
      return;
    }
    try {
      await navigator.share({
        title: "Apartment Cam Live View",
        url: viewerUrl,
      });
      setShareStatus("Shared");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("Share failed", err);
        setShareStatus("Share failed");
      }
    }
  };

  const stopZoomHold = () => {
    if (zoomHoldRef.current != null) {
      clearInterval(zoomHoldRef.current);
      zoomHoldRef.current = null;
    }
  };

  const startZoomHold = (delta: number) => {
    stopZoomHold();
    applyRelativeZoom(delta);
    zoomHoldRef.current = globalThis.setInterval(() => {
      applyRelativeZoom(delta);
    }, 200);
  };

  useEffect(() => {
    return () => {
      stopZoomHold();
    };
  }, []);

  const handleZoomKeyDown =
    (delta: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startZoomHold(delta);
      }
    };

  const handleZoomKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      stopZoomHold();
    }
  };

  const getCamRect = () => {
    if (camInnerRef.current) {
      return camInnerRef.current.getBoundingClientRect();
    }
    return camContainerRef.current?.getBoundingClientRect() ?? null;
  };

  return (
    <div className="app-root">
      {/* Fixed top bar */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-logo">
            <img
              src="/logo-dark.png"
              alt="Apartment Cam Logo"
              width={70}
              height={70}
            />
          </div>
          <div className="top-bar-text">
            <div className="top-bar-title">{topBarTitle}</div>
            <div className="top-bar-subtitle top-bar-subtitle--meta">
              {siteConfig.siteSubtitle}
            </div>
            <div className="top-bar-subtitle top-bar-subtitle--location">
              {locationTitle}
            </div>
          </div>
        </div>
        <div className="top-bar-right">
          <div className="top-bar-time-stack">
            <div className="top-bar-time-group">
              <span className="meta-label">LOCAL</span>
              <span className="meta-value meta-mono">
                {clock || "----/--/-- --:--:--"}
              </span>
            </div>
            <div className="top-bar-time-group">
              <span className="meta-label">UTC</span>
              <span className="meta-value meta-mono">
                {utcClock || "----/--/-- --:--:--"}
              </span>
            </div>
          </div>
          <span className="flag-avatar" title={countryName || "Country"}>
            {flagEmoji}
          </span>
        </div>
      </header>
      {shareStatus && <div className="share-toast">{shareStatus}</div>}

      {/* Centered camera pane */}
      <main className="center-shell">
        <div
          className={`stream-card${
            streamCardCollapsed ? " stream-card--collapsed" : ""
          }`}
        >
          <div className="stream-card__header">
            <div>
              <div className="stream-card__title">
                {isMobile ? "Primary cam" : "Main stream"}
              </div>
              <div className="stream-card__subtitle">{locationDisplayValue}</div>
            </div>
            <button
              className="btn stream-card__toggle"
              type="button"
              onClick={toggleStreamCard}
            >
              {streamCardCollapsed ? "Show stream card" : "Hide stream card"}
            </button>
          </div>
          <div className="stream-card__body">
            <div
              className={`layout-grid${
                isExpanded ? " layout-grid--expanded" : ""
              }`}
            >
              <section
                className={`cam-panel${isExpanded ? " cam-panel-expanded" : ""}`}
              >
                <div
                  className={`cam-frame-card${
                    camCollapsed ? " cam-frame-card--collapsed" : ""
                  }`}
                >
                  <div className="cam-frame-card__header">
                    <div>
                      <div className="cam-frame-card__title">Live Stream</div>
                      <div
                        className={`cam-frame-card__tag${
                          hasError
                            ? " cam-frame-card__tag--offline"
                            : " cam-frame-card__tag--live"
                        }`}
                      >
                        {hasError ? offlineStatusLabel : "LIVE"}
                      </div>
                    </div>
                    <button
                      className="btn cam-frame-card__toggle"
                      type="button"
                      onClick={toggleCamCollapse}
                      aria-pressed={camCollapsed}
                    >
                      {camCollapsed ? "Show stream" : "Hide stream"}
                    </button>
                  </div>
                  <div className="cam-frame-card__body">
                    <div
                      ref={camContainerRef}
                      className={`cam-frame ${hudVisible ? "" : "hud-hidden"}`}
                      onDragStart={(event) => event.preventDefault()}
                      onMouseDown={(e) => {
                        if (hasError) return;
                        e.preventDefault();
                        dragStart.current = { x: e.clientX, y: e.clientY };
                        setDragMoved(false);
                        const rect = getCamRect();
                        if (rect) {
                          const startX = e.clientX - rect.left;
                          const startY = e.clientY - rect.top;
                          setPanLine({
                            startX,
                            startY,
                            endX: startX,
                            endY: startY,
                          });
                          setAimBox({ x: startX, y: startY });
                        }
                        showHud();
                      }}
                      onMouseMove={(e) => {
                        if (!dragStart.current || !getCamRect() || hasError) return;
                        const rect = getCamRect()!;
                        setAimBox({ x: e.clientX - rect.left, y: e.clientY - rect.top });

                        const dx = e.clientX - dragStart.current.x;
                        const dy = e.clientY - dragStart.current.y;
                        if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;

                        setDragMoved(true);
                        setPanLine((prev) =>
                          prev
                            ? {
                                ...prev,
                                endX: e.clientX - rect.left,
                                endY: e.clientY - rect.top,
                              }
                            : null
                        );
                      }}
                      onMouseUp={(e) => {
                        if (!dragStart.current || !getCamRect()) return;
                        const rect = getCamRect()!;
                        if (dragMoved && panLine && !hasError) {
                          const dx = panLine.endX - panLine.startX;
                          const dy = panLine.endY - panLine.startY;
                          const { panRange, tiltRange } = getPanTiltRange();
                          const panDelta = (dx / rect.width) * (panRange / 4);
                          const tiltDelta = (-dy / rect.height) * (tiltRange / 4);
                          applyRelativePanTilt(panDelta, tiltDelta);
                        } else {
                          handleClickPanZoom(e.clientX, e.clientY);
                        }
                        dragStart.current = null;
                        setDragMoved(false);
                        setPanLine(null);
                      }}
                      onMouseLeave={() => {
                        dragStart.current = null;
                        setDragMoved(false);
                        setPanLine(null);
                        setAimBox(null);
                      }}
              >
                      <div className="cam-frame-inner" ref={camInnerRef}>
                        {!hasError ? (
                          <img
                            src={streamUrl}
                            alt={siteConfig.streamAltText}
                            draggable={false}
                            onDragStart={(event) => event.preventDefault()}
                            onLoad={handleStreamLoad}
                            onError={handleStreamError}
                          />
                        ) : (
                          <div className="cam-offline">
                            <canvas
                              ref={tvCanvasRef}
                              className="cam-static-canvas"
                            />
                            <div className="cam-offline-content">
                              <span className="cam-offline-pill">
                                {offlineStatusLabel}
                              </span>
                              {offlineDetailText && (
                                <span className="cam-offline-detail">
                                  {offlineDetailText}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      {loadingStatus && !status && !hasError && (
                        <div className="cam-loading">
                          <span className="loading-spinner" aria-hidden="true" />
                          <span>Loading stream…</span>
                        </div>
                      )}
                      {reticleActive && panLine && (
                        (() => {
                          const dx = panLine.endX - panLine.startX;
                          const dy = panLine.endY - panLine.startY;
                          const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                          return (
                            <div
                              className="reticle-preview-line"
                              style={{
                                width: `${length}px`,
                                transform: `translate(${panLine.startX}px, ${panLine.startY}px) rotate(${angle}deg)`,
                              }}
                            />
                          );
                        })()
                      )}
                      {wheelZoomIndicator != null && !hasError && !loadingStatus && (
                        (() => {
                          const size = Math.max(30, 70 - wheelZoomIndicator * 40);
                          const offset = (100 - size) / 2;
                          return (
                            <div
                              className="wheel-zoom-indicator"
                              style={{
                                width: `${size}%`,
                                height: `${size}%`,
                                top: `${offset}%`,
                                left: `${offset}%`,
                              }}
                            />
                          );
                        })()
                      )}
                      {reticleActive && (targetZoom || aimBox) && (
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
                    </div>
                  </div>
                </div>

                {/* Heading overlay */}
                {showHeadingOverlay && currentHeading != null && (
                  <div className="heading-overlay">
                    <div className="heading-arc" />
                    {[-60, -30, 0, 30, 60].map((offset) => {
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
                {showHudOverlay && overlaysEnabled && (
                  <div className="cam-hud cam-hud-minimal">
                    <div className="cam-hud-top">
                      <span>PITTSBURGH, PA · APARTMENT-CAM</span>
                      <span
                        className={`cam-hud-status${
                          hasError ? " cam-hud-status--offline" : ""
                        }`}
                      >
                        {hasError ? offlineStatusLabel : "LIVE"}
                      </span>
                    </div>
                  </div>
                )}

                {/* Quick overlays */}
                {showPtzOverlay && overlaysEnabled && (
                  <div className="overlay-pill overlay-ptz">
                    PTZ P {status?.optics.pan ?? "—"} · T{" "}
                    {status?.optics.tilt ?? "—"} · Z {currentZoom ?? "—"}
                  </div>
                )}
                {showTempOverlay && overlaysEnabled && (
                  <div className="overlay-pill overlay-temp">
                    Temp{" "}
                    {status?.temperature?.sensors?.[0]?.celsius?.toFixed(1) ??
                      "—"}
                    °C · PCB{" "}
                    {status?.temperature?.sensors?.[1]?.celsius?.toFixed(1) ??
                      "—"}
                    °C
                  </div>
                )}
                {showZoomMeter && overlaysEnabled && (
                  <div className="zoom-mini">
                    <div className="zoom-mini-track">
                      <div
                        className="zoom-mini-fill"
                        style={{
                          height: `${Math.max(0, Math.min(100, zoomPercent))}%`,
                        }}
                      />
                    </div>
                    <div className="zoom-mini-label">Z {currentZoom ?? "—"}</div>
                  </div>
                )}
                {showWeatherOverlay && weather && overlaysEnabled && (
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

                {/* footer under cam */}
                <div className="cam-footer">
                  <div className="cam-footer-left">
                    {siteConfig.headerText ? <h2>{siteConfig.headerText}</h2> : null}
                  </div>
                  <div className="cam-footer-right cam-footer-actions">
                    {!isMobile && (
                      <button
                        className="btn"
                        type="button"
                        onClick={handleExpand}
                        disabled={controlsDisabled}
                      >
                        {isExpanded ? "Collapse" : "Expand"}
                      </button>
                    )}
                    <button
                      className="btn"
                      type="button"
                      onClick={handleFullscreen}
                      disabled={controlsDisabled}
                    >
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
                        <div className="stats-value">{locationDisplayValue}</div>
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
                          <div className="app-subtitle">
                            Weather error: {weatherError}
                          </div>
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
                        {loadingStatus && (
                          <div className="app-subtitle">Refreshing…</div>
                        )}
                        {apiError && (
                          <div className="app-subtitle">Error: {apiError}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className={ptzPanelClassName}>
                    <div className="ptz-header">
                      <div className="stats-label">ZOOM CONTROL</div>
                      <div className="app-subtitle">Camera {cameraId}</div>
                    </div>
                    <div className="ptz-body">
                      <div className="ptz-buttons">
                        <div className="zoom-stack zoom-stack__primary">
                          <button
                            className="btn"
                            type="button"
                            onPointerDown={() => startZoomHold(200)}
                            onPointerUp={stopZoomHold}
                            onPointerLeave={stopZoomHold}
                            onPointerCancel={stopZoomHold}
                            onKeyDown={handleZoomKeyDown(200)}
                            onKeyUp={handleZoomKeyUp}
                            disabled={controlsDisabled}
                          >
                            ➕ Zoom In
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onPointerDown={() => startZoomHold(-200)}
                            onPointerUp={stopZoomHold}
                            onPointerLeave={stopZoomHold}
                            onPointerCancel={stopZoomHold}
                            onKeyDown={handleZoomKeyDown(-200)}
                            onKeyUp={handleZoomKeyUp}
                            disabled={controlsDisabled}
                          >
                            ➖ Zoom Out
                          </button>
                        </div>
                        <div className="zoom-stack zoom-stack__bounds">
                          <button
                            className="btn"
                            onClick={() => applyZoom(zoomMin)}
                            type="button"
                            disabled={controlsDisabled}
                          >
                            Min
                          </button>
                          <button
                            className="btn"
                            onClick={() => applyZoom(zoomMax)}
                            type="button"
                            disabled={controlsDisabled}
                          >
                            Max
                          </button>
                        </div>
                        <button
                          className="btn zoom-reset"
                          onClick={goHome}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          Home / Reset
                        </button>
                      </div>

                      <div className="ptz-arrows">
                        <button
                          className="btn ptz-arrow ptz-arrow-up"
                          onClick={() => applyRelativePanTilt(0, 10)}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          ▲
                        </button>
                        <button
                          className="btn ptz-arrow ptz-arrow-left"
                          onClick={() => applyRelativePanTilt(-10, 0)}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          ◀
                        </button>
                        <button
                          className="btn ptz-arrow ptz-arrow-home"
                          onClick={goHome}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          Home
                        </button>
                        <button
                          className="btn ptz-arrow ptz-arrow-right"
                          onClick={() => applyRelativePanTilt(10, 0)}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          ▶
                        </button>
                        <button
                          className="btn ptz-arrow ptz-arrow-down"
                          onClick={() => applyRelativePanTilt(0, -10)}
                          type="button"
                          disabled={controlsDisabled}
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <aside className="side-column">
                <div className="layer-panel">
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
                </div>
                <div className={sharePanelClassName}>
                  <div className="share-header">
                    <div className="stats-label">Share</div>
                  </div>
                  <div className="share-actions">
                    <button
                      className="btn share-btn share-btn--split"
                      type="button"
                      onClick={() => copyToClipboard(viewerUrl, "Viewer link")}
                      disabled={controlsDisabled}
                    >
                      <span>Copy link</span>
                      <span aria-hidden="true">📋</span>
                    </button>
                    <button
                      className="btn share-btn share-btn--split"
                      type="button"
                      onClick={handleNativeShare}
                      disabled={controlsDisabled}
                    >
                      <span>Share</span>
                      <span aria-hidden="true" className="share-icon" />
                    </button>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
