"use client";

import { useEffect, useRef, useState } from "react";

const STREAM_URL = "https://cam.ebox86.com/stream";

export default function ApartmentCamPage() {
  const camContainerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [clock, setClock] = useState<string>("");

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

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

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
              High-rise MJPEG viewer · read-only
            </div>
          </div>
        </div>
        <div className="top-bar-right">
          <span className="meta-label">LOCAL</span>
          <span className="meta-value meta-mono">
            {clock || "----/--/-- --:--:--"}
          </span>
        </div>
      </header>

      {/* Centered camera pane */}
      <main className="center-shell">
        <section className="cam-panel">
          <div ref={camContainerRef} className="cam-frame">
            <div className="cam-frame-inner">
              {!hasError ? (
                <img
                  src={STREAM_URL}
                  alt="Pittsburgh skyline live camera"
                  onError={() => setHasError(true)}
                />
              ) : (
                <div className="cam-offline">
                  <span>STREAM OFFLINE / UNREACHABLE</span>
                </div>
              )}
            </div>

            {/* HUD overlay */}
            <div className="cam-hud">
              <div className="cam-hud-top">
                <span>PITTSBURGH, PA · APARTMENT-CAM</span>
                <span>
                  <span className="status-dot" />
                  MJPEG · <span className="live-pill">LIVE</span>
                </span>
              </div>
              <div className="cam-hud-bottom">
                <span>
                  LAT/LON{" "}
                  <span className="meta-mono">40.4406° N</span>{" "}
                  <span className="meta-mono">79.9959° W</span>{" "}
                  <span className="app-subtitle">(approx)</span>
                </span>
                <span>
                  ALT{" "}
                  <span className="meta-mono">~30 FLOORS / ~120 m</span>
                </span>
              </div>
            </div>
          </div>

          {/* footer under cam */}
          <div className="cam-footer">
            <div className="cam-footer-left meta-mono">
              Pittsburgh · Pennsylvania · USA
            </div>
            <div className="cam-footer-right">
              <button className="btn" type="button" onClick={handleFullscreen}>
                {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              </button>
            </div>
          </div>

          {/* hacky stats panel */}
          <div className="stats-panel">
            <div className="stats-grid">
              <div className="stats-item">
                <div className="stats-label">LOCATION</div>
                <div className="stats-value">Pittsburgh, Pennsylvania, USA</div>
              </div>
              <div className="stats-item">
                <div className="stats-label">COORDINATES (APPROX)</div>
                <div className="stats-value meta-mono">
                  40.4406° N / 79.9959° W
                </div>
              </div>
              <div className="stats-item">
                <div className="stats-label">ELEVATION</div>
                <div className="stats-value meta-mono">
                  ~30 floors · ~120 m ASL
                </div>
              </div>
              <div className="stats-item">
                <div className="stats-label">WEATHER</div>
                <div className="stats-value meta-mono">
                  TODO · hook real sensor / API
                </div>
              </div>
              <div className="stats-item">
                <div className="stats-label">NOTES</div>
                <div className="stats-value">
                  Telemetry values are approximate placeholders. Wire in hardware
                  or APIs later for live data.
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
