// In-memory business metrics counters — no external dependencies.

const DEFAULT_COUNTERS = {
  invoicesCreated: 0,
  invoicesTotalAmount: 0,
  marketplaceOrders: 0,
  stockAdjustments: 0,
  loginAttempts: 0,
  loginFailures: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

let counters = { ...DEFAULT_COUNTERS };
let reportingInterval = null;

/**
 * Increment a named counter by the given value (default 1).
 * Unknown counter names are created dynamically.
 */
export function incrementCounter(name, value = 1) {
  if (typeof counters[name] === "number") {
    counters[name] += value;
  } else {
    // Allow dynamic counters beyond the predefined set
    counters[name] = (counters[name] ?? 0) + value;
  }
}

/**
 * Returns a shallow copy of all counters plus a snapshot timestamp (ISO 8601).
 */
export function getMetrics() {
  return {
    ...counters,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Resets all counters back to zero (preserves counter names, including dynamic ones).
 */
export function resetMetrics() {
  for (const key of Object.keys(counters)) {
    counters[key] = 0;
  }
}

/**
 * Starts a setInterval that logs a metrics snapshot every 5 minutes.
 * Calling this while reporting is already active is a no-op — returns the
 * existing interval handle.
 *
 * @returns {NodeJS.Timeout} The interval handle (pass to stopMetricsReporting if needed).
 */
export function startMetricsReporting() {
  if (reportingInterval !== null) {
    return reportingInterval;
  }

  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  reportingInterval = setInterval(() => {
    const snapshot = getMetrics();
    console.log("[metrics] snapshot:", JSON.stringify(snapshot));
  }, FIVE_MINUTES_MS);

  // Allow the process to exit even if this interval is still active
  if (reportingInterval.unref) {
    reportingInterval.unref();
  }

  return reportingInterval;
}

/**
 * Clears the active reporting interval (if any).
 */
export function stopMetricsReporting() {
  if (reportingInterval !== null) {
    clearInterval(reportingInterval);
    reportingInterval = null;
  }
}
