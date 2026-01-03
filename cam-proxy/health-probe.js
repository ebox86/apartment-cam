const targets = [
  {
    name: "cam-proxy",
    url:
      process.env.CAM_PROXY_HEALTH_URL ||
      "http://cam-proxy:3000/api/health",
  },
  {
    name: "go2rtc",
    url:
      process.env.GO2RTC_HEALTH_URL || "http://go2rtc:1984/api/streams",
  },
];

const intervalMs = Number(process.env.PROBE_INTERVAL_MS || 15000);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 5000);
const repeatFailLogMs = Number(process.env.PROBE_FAIL_LOG_MS || 60000);

const state = new Map();

const logLine = (message) => {
  console.log(`[probe ${new Date().toISOString()}] ${message}`);
};

async function checkTarget(target) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(target.url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, ms: Date.now() - started, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runProbe() {
  for (const target of targets) {
    const result = await checkTarget(target);
    const now = Date.now();
    const prev = state.get(target.name) || {
      ok: null,
      lastLogAt: 0,
    };
    const shouldLog =
      prev.ok !== result.ok ||
      (!result.ok && now - prev.lastLogAt > repeatFailLogMs);

    if (shouldLog) {
      const base = `${target.name} ${result.ok ? "OK" : "DOWN"} ${result.ms}ms`;
      const detail = result.ok ? "" : ` (${result.error})`;
      logLine(`${base}${detail}`);
      prev.lastLogAt = now;
    }
    prev.ok = result.ok;
    state.set(target.name, prev);
  }
}

logLine("starting health probe");
runProbe();
setInterval(runProbe, intervalMs);
