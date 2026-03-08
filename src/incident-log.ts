import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FrictionLevel, Constraint, Signature } from "./friction-policy";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface IncidentFragment {
  id: string;
  timestamp: string;
  userId: string;
  source: "user" | "agent";
  text: string;
  level: FrictionLevel;
  markers: string[];            // evidence entry ids that triggered
  baselineDeviation: number;
  constraintsActivated: Constraint[];
  signatureDeltas: Partial<Record<Signature, number>>;
  resolved: boolean;            // background process sets this after analysis
  clusterKey?: string;          // set by background process when grouped
  reclassifiedLevel?: FrictionLevel; // if background process changes assessment
  notes?: string;               // background process can annotate
}

export interface IncidentLog {
  userId: string;
  updatedAt: string;
  fragments: IncidentFragment[];
}

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────

const LOG_DIR = join(__dirname, "..", "memory", "incident-logs");

function logPath(userId: string): string {
  return join(LOG_DIR, `${userId}.json`);
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ──────────────────────────────────────────────
// Read / Write
// ──────────────────────────────────────────────

export function readLog(userId: string): IncidentLog {
  ensureDir(LOG_DIR);
  const p = logPath(userId);
  if (!existsSync(p)) {
    return { userId, updatedAt: new Date().toISOString(), fragments: [] };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeLog(log: IncidentLog): void {
  ensureDir(LOG_DIR);
  log.updatedAt = new Date().toISOString();
  writeFileSync(logPath(log.userId), JSON.stringify(log, null, 2), "utf8");
}

// ──────────────────────────────────────────────
// Log a fragment
// ──────────────────────────────────────────────

let _counter = 0;

function generateId(): string {
  _counter++;
  return `inc-${Date.now()}-${_counter}`;
}

export function logFragment(
  userId: string,
  source: "user" | "agent",
  text: string,
  level: FrictionLevel,
  markers: string[],
  baselineDeviation: number,
  constraintsActivated: Constraint[],
  signatureDeltas: Partial<Record<Signature, number>>
): IncidentFragment {
  const log = readLog(userId);

  const fragment: IncidentFragment = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    userId,
    source,
    text: text.slice(0, 500), // cap stored text length
    level,
    markers,
    baselineDeviation,
    constraintsActivated,
    signatureDeltas,
    resolved: false,
  };

  log.fragments.push(fragment);

  // Rolling window: keep last 200 fragments max
  if (log.fragments.length > 200) {
    log.fragments = log.fragments.slice(-200);
  }

  writeLog(log);
  return fragment;
}

// ──────────────────────────────────────────────
// Query helpers (for background process)
// ──────────────────────────────────────────────

export function getUnresolved(userId: string): IncidentFragment[] {
  return readLog(userId).fragments.filter((f) => !f.resolved);
}

export function getFragmentsSince(
  userId: string,
  sinceMs: number
): IncidentFragment[] {
  const cutoff = Date.now() - sinceMs;
  return readLog(userId).fragments.filter(
    (f) => new Date(f.timestamp).getTime() >= cutoff
  );
}

export function getFragmentsByLevel(
  userId: string,
  minLevel: FrictionLevel
): IncidentFragment[] {
  return readLog(userId).fragments.filter((f) => f.level >= minLevel);
}

export function markResolved(
  userId: string,
  fragmentId: string,
  clusterKey?: string,
  reclassifiedLevel?: FrictionLevel,
  notes?: string
): void {
  const log = readLog(userId);
  const fragment = log.fragments.find((f) => f.id === fragmentId);
  if (fragment) {
    fragment.resolved = true;
    if (clusterKey) fragment.clusterKey = clusterKey;
    if (reclassifiedLevel !== undefined) fragment.reclassifiedLevel = reclassifiedLevel;
    if (notes) fragment.notes = notes;
  }
  writeLog(log);
}
