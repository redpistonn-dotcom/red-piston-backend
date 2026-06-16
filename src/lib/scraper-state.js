/**
 * In-memory scraper state for the autodukan Playwright scraper.
 * Persists within the Node process lifetime only.
 * DB tables (autodukan_scrape_progress, autodukan_parts_staging) are the
 * durable store — this module only holds ephemeral runtime state.
 */

const MAX_LOGS = 100;

let state = {
  running:         false,
  pid:             null,
  startedAt:       null,
  stoppedAt:       null,
  currentCategory: null,
  currentPage:     null,
  exitCode:        null,
  logs:            [],        // last MAX_LOGS stdout/stderr lines from the child
  error:           null,
};

export function getScraperState() {
  return { ...state, logs: [...state.logs] };
}

export function setScraperRunning(pid, category) {
  state.running         = true;
  state.pid             = pid;
  state.startedAt       = new Date().toISOString();
  state.stoppedAt       = null;
  state.currentCategory = category;
  state.currentPage     = null;
  state.exitCode        = null;
  state.error           = null;
  state.logs            = [];
}

export function setScraperStopped(exitCode) {
  state.running   = false;
  state.pid       = null;
  state.stoppedAt = new Date().toISOString();
  state.exitCode  = exitCode;
}

export function appendScraperLog(line) {
  state.logs.push({ ts: new Date().toISOString(), line: String(line).trim() });
  if (state.logs.length > MAX_LOGS) state.logs.shift();

  // Parse progress hints from stdout lines produced by the script
  // Format: "  [12/117845] 9 products (running total: 108)"
  const pageMatch = line.match(/\[(\d+)\/(\d+)\]/);
  if (pageMatch) state.currentPage = parseInt(pageMatch[1]);

  // Format: "  Subcategory: FILTERS"
  const catMatch = line.match(/Subcategory:\s*(.+)/);
  if (catMatch) state.currentCategory = catMatch[1].trim();
}

export function setScraperError(msg) {
  state.error = String(msg);
}
