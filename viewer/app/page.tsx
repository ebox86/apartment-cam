"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  isHLSProvider,
  useMediaRemote,
  type MediaErrorDetail,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import { siteConfig } from "../config/site-config";
import ViewerHeader from "./components/ViewerHeader";

const DEFAULT_API_BASE = "https://cam-api.ebox86.com";
const DEFAULT_STREAM_URL =
  "https://cam.ebox86.com/api/stream.m3u8?src=axis&mp4";
const DEFAULT_CAMERA_ID = 1;
const STREAM_OFFLINE_LABEL = "STREAM OFFLINE";
const ZOOM_HOLD_STEP = 24;
const ZOOM_HOLD_INTERVAL = 90;
const WHEEL_ZOOM_COMMIT_DELAY = 220;
const VIEWER_ID_KEY = "apartment-cam-viewer-id";
const TELEMETRY_RETRY_BASE_DELAY = 2000;
const TELEMETRY_RETRY_MAX_DELAY = 20000;
const TELEMETRY_RETRY_MAX_ATTEMPTS = 6;
const STREAM_RETRY_BASE_DELAY = 2000;
const STREAM_RETRY_INCREMENT = 2000;
const STREAM_RETRY_MAX_DELAY = 20000;
const STREAM_RETRY_MAX_ATTEMPTS = 6;
const STREAM_OFFLINE_RETRY_DELAY = 30000;
const STREAM_BUFFERING_DELAY_MS = 600;

const generateViewerId = () => {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `viewer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
};

function normalizeStreamUrl(value: string) {
  return value;
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
  const playerRef = useRef<MediaPlayerInstance | null>(null);
  const mediaRemote = useMediaRemote(playerRef);
  const hideHudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const zoomHoldRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tvCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aimBox, setAimBox] = useState<{ x: number; y: number } | null>(null);
  const [dragMoved, setDragMoved] = useState(false);
  const [panLine, setPanLine] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);
  const wheelIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelZoomCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wheelZoomIndicator, setWheelZoomIndicator] = useState<number | null>(
    null
  );
  const initialApiBase = DEFAULT_API_BASE;
  const directApiBase = DEFAULT_API_BASE;
  const initialCameraId = DEFAULT_CAMERA_ID;
  const initialStreamUrl = normalizeStreamUrl(DEFAULT_STREAM_URL);
  const [config] = useState<AppConfig>({
    apiBase: initialApiBase,
    cameraId: initialCameraId,
    streamUrl: initialStreamUrl,
  });
  const cameraId = config.cameraId;
  const [useDirectApi, setUseDirectApi] = useState(false);
  const [apiFailureCount, setApiFailureCount] = useState(0);
  const apiBase = useMemo(
    () => (useDirectApi && directApiBase ? directApiBase : config.apiBase),
    [useDirectApi, directApiBase, config.apiBase]
  );
  const apiUrl = useCallback((path: string) => `${apiBase}${path}`, [apiBase]);
  const recordApiSuccess = useCallback(() => {
    setApiFailureCount(0);
  }, []);
  const recordApiFailure = useCallback(
    (status?: number) => {
      setApiFailureCount((count) => {
        const next = count + 1;
        if (
          !useDirectApi &&
          directApiBase &&
          (status == null || status >= 500) &&
          next >= 2
        ) {
          setUseDirectApi(true);
        }
        return next;
      });
    },
    [directApiBase, useDirectApi]
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const streamUrl = useMemo(
    () => normalizeStreamUrl(config.streamUrl || DEFAULT_STREAM_URL),
    [config.streamUrl]
  );
  const playerSrc = useMemo(
    () => ({ src: streamUrl, type: "application/x-mpegurl" as const }),
    [streamUrl]
  );
  const [hasError, setHasError] = useState(false);
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
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
const [zoomButtonActive, setZoomButtonActive] = useState<"in" | "out" | null>(
  null
);
  const [isMobile, setIsMobile] = useState(false);
  const [streamCardCollapsed, setStreamCardCollapsed] = useState(false);
  const [streamRetryKey, setStreamRetryKey] = useState(0);
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [streamRecovering, setStreamRecovering] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [needsUserPlay, setNeedsUserPlay] = useState(false);
  const handleProviderChange = useCallback(
    (provider: MediaProviderAdapter | null) => {
      if (!provider || !isHLSProvider(provider)) return;
      provider.config = {
        ...provider.config,
        preferManagedMediaSource: false,
      };
    },
    []
  );

  const ViewerCountPill = ({ className }: { className?: string }) => (
    <div
      className={`cam-footer-viewers cam-footer-pill ${className || ""}`}
      aria-live="polite"
      aria-label={`Viewers: ${viewerCount != null ? viewerCount : "—"}`}
    >
      <span className="cam-footer-viewers__icon" aria-hidden="true">
        👤
      </span>
      <span className="cam-footer-viewers__count">
        {viewerCount != null ? viewerCount : "—"}
      </span>
    </div>
  );

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

  const getZoomButtonClass = (direction: "in" | "out") =>
    `btn zoom-control${
      zoomButtonActive === direction ? " zoom-control--active" : ""
    }`;

  const getVideoElement = useCallback(() => {
    const container = camInnerRef.current;
    if (!container) return null;
    const video = container.querySelector("video");
    return video instanceof HTMLVideoElement ? video : null;
  }, []);

  const isVideoFullscreen = useCallback(() => {
    const video = getVideoElement() as (HTMLVideoElement & {
      webkitDisplayingFullscreen?: boolean;
    }) | null;
    return Boolean(video?.webkitDisplayingFullscreen);
  }, [getVideoElement]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setViewerUrl(window.location.href);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let stored = window.localStorage.getItem(VIEWER_ID_KEY);
    if (!stored) {
      stored = generateViewerId();
      window.localStorage.setItem(VIEWER_ID_KEY, stored);
    }
    setViewerId(stored);
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
    if (typeof window === "undefined") return;
    const ua = navigator.userAgent || "";
    const iOSDevice =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    setIsIOS(iOSDevice);
  }, []);

  useEffect(() => {
    return () => {
      if (wheelIndicatorTimer.current) {
        globalThis.clearTimeout(wheelIndicatorTimer.current);
        wheelIndicatorTimer.current = null;
      }
      if (wheelZoomCommitTimer.current) {
        globalThis.clearTimeout(wheelZoomCommitTimer.current);
        wheelZoomCommitTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        globalThis.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (offlineRetryRef.current) {
        globalThis.clearTimeout(offlineRetryRef.current);
        offlineRetryRef.current = null;
      }
      if (bufferingTimerRef.current) {
        globalThis.clearTimeout(bufferingTimerRef.current);
        bufferingTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isMobile) {
      setIsExpanded(true);
    }
  }, [isMobile]);

  // fullscreen tracking
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(
        Boolean(getActiveFullscreenElement()) || isVideoFullscreen()
      );
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

  useEffect(() => {
    const video = getVideoElement();
    if (!video) return undefined;

    const handleBegin = () => setIsFullscreen(true);
    const handleEnd = () => setIsFullscreen(false);
    video.addEventListener("webkitbeginfullscreen", handleBegin);
    video.addEventListener("webkitendfullscreen", handleEnd);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", handleBegin);
      video.removeEventListener("webkitendfullscreen", handleEnd);
    };
  }, [getVideoElement, streamRetryKey, streamUrl]);

  // camera telemetry stream (SSE)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!viewerId) return;

    let eventSource: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let closed = false;

    const stopRetry = () => {
      if (retryTimeout) {
        globalThis.clearTimeout(retryTimeout);
        retryTimeout = null;
      }
    };

    const connect = () => {
      if (closed) return;
      stopRetry();
      setLoadingStatus(true);

      const base = apiUrl("/api/telemetry/stream");
      const streamUrl = new URL(base, window.location.href);
      streamUrl.searchParams.set("id", viewerId);
      eventSource = new EventSource(streamUrl.toString());

      eventSource.addEventListener("connected", () => {
        setApiError(null);
        recordApiSuccess();
      });

      eventSource.addEventListener("status", (event) => {
        try {
          const payload = JSON.parse(event.data) as StatusResponse;
          setStatus(payload);
          setApiError(null);
          setLoadingStatus(false);
          recordApiSuccess();
        } catch {
          // ignore malformed payloads
        }
      });

      eventSource.addEventListener("status-error", (event) => {
        try {
          const payload = JSON.parse(event.data) as { error?: string };
          setApiError(payload.error || "Status stream error.");
        } catch {
          setApiError("Status stream error.");
        }
        setLoadingStatus(false);
        recordApiFailure();
      });

      eventSource.addEventListener("viewers", (event) => {
        try {
          const payload = JSON.parse(event.data) as { count?: number };
          setViewerCount(
            typeof payload.count === "number" ? payload.count : null
          );
        } catch {
          setViewerCount(null);
        }
      });

      eventSource.onerror = () => {
        recordApiFailure();
        setApiError(
          "Telemetry stream disconnected. Waiting to reconnect..."
        );
        setViewerCount(null);
        setLoadingStatus(false);
        if (eventSource?.readyState === EventSource.CLOSED) {
          if (retryCount >= TELEMETRY_RETRY_MAX_ATTEMPTS) return;
          const delay = Math.min(
            TELEMETRY_RETRY_MAX_DELAY,
            TELEMETRY_RETRY_BASE_DELAY * 2 ** retryCount
          );
          retryCount += 1;
          retryTimeout = globalThis.setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      stopRetry();
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [apiUrl, recordApiFailure, recordApiSuccess, viewerId]);

  // camera capabilities (one-shot)
  useEffect(() => {
    let mounted = true;
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

    fetchCaps();
    return () => {
      mounted = false;
    };
  }, [apiUrl]);

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
      const video = getVideoElement();
      if (!activeElement && !isVideoFullscreen() && camContainerRef.current) {
        let didEnter = false;
        try {
          didEnter = await enterFullscreen(camContainerRef.current);
        } catch {
          didEnter = false;
        }
        if (!didEnter && video) {
          const webkitEnterFullscreen = (
            video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
          ).webkitEnterFullscreen;
          if (typeof webkitEnterFullscreen === "function") {
            webkitEnterFullscreen.call(video);
          }
        }
      } else {
        let didExit = false;
        try {
          didExit = await exitFullscreen();
        } catch {
          didExit = false;
        }
        if (!didExit && video) {
          const webkitExitFullscreen = (
            video as HTMLVideoElement & { webkitExitFullscreen?: () => void }
          ).webkitExitFullscreen;
          if (typeof webkitExitFullscreen === "function") {
            webkitExitFullscreen.call(video);
          }
        }
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
  const spinnerVisible =
    (loadingStatus && !status && !hasError) || streamRecovering || isBuffering;
  const reticleActive =
    showReticle &&
    !hasError &&
    !loadingStatus &&
    !spinnerVisible &&
    !zoomAtExtremeOut &&
    !isMobile;
  const locationTitle = titleLocationValue || siteConfig.siteTitleLocationFallback;
  const topBarTitle = siteConfig.siteTitle;
  const controlsDisabled = hasError;
  const locationDisplayValue =
    status?.geolocation && locationLabelValue ? locationLabelValue : "—";
  const offlineStatusLabel = STREAM_OFFLINE_LABEL;
  const overlaysEnabled = !hasError && !isMobile && !spinnerVisible;
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
      if (wheelZoomCommitTimer.current) {
        globalThis.clearTimeout(wheelZoomCommitTimer.current);
      }
      wheelZoomCommitTimer.current = globalThis.setTimeout(() => {
        wheelZoomCommitTimer.current = null;
        applyZoom(next);
      }, WHEEL_ZOOM_COMMIT_DELAY);
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
    if (!hasError || streamRecovering) return undefined;
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
  }, [hasError, streamRecovering, streamUrl]);

  const clearOfflineRetry = useCallback(() => {
    if (offlineRetryRef.current) {
      globalThis.clearTimeout(offlineRetryRef.current);
      offlineRetryRef.current = null;
    }
  }, []);

  const clearBufferingTimer = useCallback(() => {
    if (bufferingTimerRef.current) {
      globalThis.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  }, []);

  const startBufferingTimer = useCallback(() => {
    if (bufferingTimerRef.current) return;
    bufferingTimerRef.current = globalThis.setTimeout(() => {
      bufferingTimerRef.current = null;
      setIsBuffering(true);
    }, STREAM_BUFFERING_DELAY_MS);
  }, []);

  const handleStreamLoad = () => {
    clearOfflineRetry();
    clearBufferingTimer();
    setHasError(false);
    setStreamRecovering(false);
    setStreamIssueDetail(null);
    setIsBuffering(false);
    setNeedsUserPlay(false);
    if (retryTimeoutRef.current) {
      globalThis.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    setAutoRetryCount(0);
    const player = playerRef.current;
    if (player) {
      player.muted = true;
      if (player.paused) {
        void player.play().catch(() => {
          if (isIOS) {
            setNeedsUserPlay(true);
          }
        });
      }
    }
  };

  const handleAutoPlayFail = useCallback(() => {
    if (!isIOS) return;
    setNeedsUserPlay(true);
  }, [isIOS]);

  const handleTapToPlay = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setNeedsUserPlay(false);
      mediaRemote.setTarget(event.currentTarget);
      mediaRemote.play(event.nativeEvent);
    },
    [mediaRemote]
  );
  
  const scheduleStreamRetry = useCallback(() => {
    if (retryTimeoutRef.current) return;
    setStreamRecovering(true);
    setAutoRetryCount((count) => {
      const next = count + 1;
      const delay = Math.min(
        STREAM_RETRY_MAX_DELAY,
        STREAM_RETRY_BASE_DELAY + next * STREAM_RETRY_INCREMENT
      );
      retryTimeoutRef.current = globalThis.setTimeout(() => {
        setStreamRetryKey((key) => key + 1);
      }, delay);
      return next;
    });
  }, []);

  const scheduleOfflineRetry = useCallback(() => {
    if (offlineRetryRef.current) return;
    offlineRetryRef.current = globalThis.setTimeout(() => {
      offlineRetryRef.current = null;
      setAutoRetryCount(0);
      setStreamRecovering(true);
      setStreamRetryKey((key) => key + 1);
    }, STREAM_OFFLINE_RETRY_DELAY);
  }, []);

  const stopAutoRetry = useCallback(() => {
    if (retryTimeoutRef.current) {
      globalThis.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    clearOfflineRetry();
    clearBufferingTimer();
    setIsBuffering(false);
    setStreamRecovering(false);
  }, [clearBufferingTimer, clearOfflineRetry]);

  const markStreamOffline = useCallback(
    (detail?: string, allowRetry = true) => {
      clearBufferingTimer();
      setIsBuffering(false);
      setHasError(true);
      if (detail) {
        setStreamIssueDetail(detail);
      }
      if (!allowRetry) {
        stopAutoRetry();
        return;
      }
      if (autoRetryCount + 1 > STREAM_RETRY_MAX_ATTEMPTS) {
        stopAutoRetry();
        scheduleOfflineRetry();
        return;
      }
      scheduleStreamRetry();
    },
    [
      autoRetryCount,
      clearBufferingTimer,
      scheduleOfflineRetry,
      scheduleStreamRetry,
      stopAutoRetry,
    ]
  );

  const retryStream = useCallback(() => {
    if (retryTimeoutRef.current) {
      globalThis.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    clearOfflineRetry();
    clearBufferingTimer();
    setAutoRetryCount(0);
    setStreamRecovering(true);
    setHasError(false);
    setStreamIssueDetail(null);
    setIsBuffering(false);
    setStreamRetryKey((key) => key + 1);
  }, [clearBufferingTimer, clearOfflineRetry]);

  const handleStreamError = useCallback(
    (detail?: MediaErrorDetail) => {
      if (hasError || detail?.code === 1) return;
      const message = detail?.message;
      if (detail?.code === 4) {
        markStreamOffline(message || "Stream unavailable", false);
        return;
      }
      startBufferingTimer();
      if (message) {
        setStreamIssueDetail(message);
      }
    },
    [hasError, markStreamOffline, startBufferingTimer]
  );

  const handleStreamWaiting = useCallback(() => {
    if (hasError) return;
    startBufferingTimer();
  }, [hasError, startBufferingTimer]);

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
    setZoomButtonActive(null);
  };

  const startZoomHold = (delta: number) => {
    stopZoomHold();
    const direction: "in" | "out" = delta > 0 ? "in" : "out";
    const step = direction === "in" ? ZOOM_HOLD_STEP : -ZOOM_HOLD_STEP;
    setZoomButtonActive(direction);
    applyRelativeZoom(step);
    zoomHoldRef.current = globalThis.setInterval(() => {
      applyRelativeZoom(step);
    }, ZOOM_HOLD_INTERVAL);
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
      <ViewerHeader
        topBarTitle={topBarTitle}
        subtitle={locationTitle || siteConfig.siteSubtitle}
      />
      {shareStatus && <div className="share-toast">{shareStatus}</div>}

      {/* Centered camera pane */}
      <main className="center-shell">
        <div className="stream-card-stack">
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
              {streamCardCollapsed ? "Open" : "Close"}
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
                <div className="cam-frame-card">
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
                        {(!hasError || streamRecovering) && (
                          <MediaPlayer
                            key={`${streamUrl}-${streamRetryKey}`}
                            ref={playerRef}
                            className="cam-media-player"
                            title={siteConfig.streamAltText}
                            src={playerSrc}
                            muted
                            autoPlay
                            playsInline
                            preferNativeHLS={isIOS}
                            preload="metadata"
                            controls={false}
                            logLevel="silent"
                            onProviderChange={handleProviderChange}
                            onAutoPlayFail={handleAutoPlayFail}
                            onCanPlay={handleStreamLoad}
                            onLoadedData={handleStreamLoad}
                            onPlaying={handleStreamLoad}
                            onWaiting={handleStreamWaiting}
                            onStalled={handleStreamWaiting}
                            onError={(detail) => handleStreamError(detail)}
                          >
                            <MediaProvider
                              mediaProps={{
                                "aria-label": siteConfig.streamAltText,
                                draggable: false,
                              }}
                            />
                          </MediaPlayer>
                        )}
                      {hasError && !streamRecovering && (
                          <div className="cam-offline">
                            <canvas
                              ref={tvCanvasRef}
                              className="cam-static-canvas"
                            />
                            <div className="cam-offline-content">
                              <span className="cam-offline-pill">
                                {offlineStatusLabel}
                              </span>
                              <div className="cam-offline-detail">
                                {streamRecovering
                                  ? "Reconnecting…"
                                  : streamIssueDetail || "Stream unavailable"}
                              </div>
                              <button
                                className="btn cam-offline-button"
                                type="button"
                                onClick={retryStream}
                                disabled={controlsDisabled}
                              >
                                Retry stream
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {((loadingStatus && !status && !hasError) || streamRecovering) && (
                        <div className="cam-loading">
                          <span className="loading-spinner" aria-hidden="true" />
                          <span>Loading</span>
                        </div>
                      )}
                      {needsUserPlay && !hasError && !spinnerVisible && (
                        <div className="cam-tap-overlay">
                          <button
                            className="btn cam-tap-button"
                            type="button"
                            onClick={handleTapToPlay}
                          >
                            Tap to play
                          </button>
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
                      {wheelZoomIndicator != null &&
                        !hasError &&
                        !loadingStatus &&
                        !spinnerVisible && (
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
                      {/* Heading overlay */}
                      {showHeadingOverlay && currentHeading != null && !spinnerVisible && (
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
                    </div>
                  </div>
                </div>


                {/* footer under cam */}
                <div className="cam-footer">
                <div className="cam-footer-left">
                    <div className="cam-footer-title">
                      {siteConfig.headerText ? <h2>{siteConfig.headerText}</h2> : null}
                      {siteConfig.headerDescription ? (
                        <p className="cam-footer-title-description">
                          {siteConfig.headerDescription}
                        </p>
                      ) : null}
                    </div>
                    {isMobile && (
                      <div className="cam-footer-mobile-bar">
                        <ViewerCountPill className="cam-footer-viewers-mobile" />
                        <button
                          className="cam-footer-pill-btn"
                          type="button"
                          onClick={() => copyToClipboard(viewerUrl, "Viewer link")}
                          disabled={!viewerUrl || controlsDisabled}
                        >
                          Copy link
                        </button>
                        <button
                          className="cam-footer-pill-btn"
                          type="button"
                          onClick={handleNativeShare}
                          disabled={controlsDisabled}
                        >
                          Share
                        </button>
                        <button
                          className="cam-footer-pill-btn cam-footer-fullscreen-btn"
                          type="button"
                          onClick={handleFullscreen}
                          disabled={controlsDisabled}
                          aria-label={
                            isFullscreen ? "Exit fullscreen" : "Fullscreen"
                          }
                        >
                          <span aria-hidden="true">⤢</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="cam-footer-right cam-footer-actions">
                    <ViewerCountPill className="cam-footer-viewers-desktop" />
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
                      className="btn cam-footer-fullscreen-desktop"
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
                      <div className="stats-item stats-item--time">
                        <div className="stats-label">TIME</div>
                        <div className="stats-value meta-mono">
                          {status?.time.cameraTime || "—"}
                        </div>
                        {status?.time.timezone && (
                          <div className="app-subtitle">{status.time.timezone}</div>
                        )}
                      </div>
                      <div className="stats-item stats-item--temperature">
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
                      <div className="stats-item stats-item--ptz-data">
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
                          className={getZoomButtonClass("in")}
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
                          className={getZoomButtonClass("out")}
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
          {isMobile && (
            <button
              className="btn mobile-add-camera"
              type="button"
              disabled
              aria-label="Add camera (coming soon)"
            >
              Add camera
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
