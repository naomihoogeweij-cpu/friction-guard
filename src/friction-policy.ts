import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type Signature =
  | "cliche_empathy"
  | "premature_advice"
  | "bullet_mismatch"
  | "over_explain"
  | "repetition"
  | "helpdesk_tone"
  | "confirm_without_deliver";

export type Constraint =
  | "BAN_CLICHE_PHRASES"
  | "NO_UNASKED_ADVICE_EMOTIONAL"
  | "DEFAULT_PROSE"
  | "MAX_LEN_600"
  | "NO_HELPDESK"
  | "NO_REPETITION"
  | "EXECUTE_FIRST";

export type FrictionLevel = 0 | 1 | 2 | 3;

export type DetectionMethod =
  | "pattern"
  | "pattern_plus_context"
  | "computed"
  | "semantic_similarity";

export interface EvidenceEntry {
  id: string;
  level: FrictionLevel;
  severity: number;
  type: "structural" | "verbal" | "agent_trigger";
  marker: string;
  description?: string;
  patterns?: Record<string, string[]>;
  detection: DetectionMethod;
  contexts: ("emotional" | "technical" | "neutral")[];
  suggestedConstraints: Constraint[];
  notes?: string;
}

export interface BannedPhrase {
  phrase: string;
  severity: number;
  source: string;
  expiresAt: string;
}

export interface BaselineProfile {
  avgMessageLength: number;
  avgSentenceCount: number;
  greetingPresent: boolean;
  typicalResponseTimeMs: number;
  lastCalibrated: string;
  turnCount: number;
}

export interface UserProfile {
  userId: string;
  updatedAt: string;
  signatures: Record<Signature, number>;
  constraints: {
    id: Constraint;
    enabled: boolean;
    confidence: number;
    lastTriggered?: string;
  }[];
  bannedPhrases: BannedPhrase[];
  baseline: BaselineProfile;
  currentFrictionLevel: FrictionLevel;
  recentTurnLengths: number[];
}

export interface FrictionGuardConfig {
  /** Directory where user profiles are stored */
  profileDir?: string;
  /** Path to the evidence registry JSON file */
  evidencePath?: string;
  /** Directory for incident logs */
  incidentLogDir?: string;
  /** Directory for turn history */
  turnHistoryDir?: string;
  /** Primary language for pattern matching ("en" | "nl" or any key in evidence patterns) */
  defaultLanguage?: string;
  /** Maximum response length when MAX_LEN constraint is active (default: 600) */
  maxResponseLength?: number;
  /** Hours before unused constraints start decaying (default: 48) */
  constraintDecayHours?: number;
  /** Temporal ban base TTL in hours (default: 2) */
  banTtlHours?: number;
  /** Background analysis interval in minutes (default: 15) */
  backgroundIntervalMinutes?: number;
}

// ──────────────────────────────────────────────
// Paths — resolved from __dirname by default,
// overridable via FrictionGuardConfig
// ──────────────────────────────────────────────

let _profileDir = join(__dirname, "..", "memory", "interaction-profiles");
let _evidencePath = join(__dirname, "friction-evidence.json");

export function configurePaths(config: FrictionGuardConfig) {
  if (config.profileDir) _profileDir = config.profileDir;
  if (config.evidencePath) _evidencePath = config.evidencePath;
}

// ──────────────────────────────────────────────
// Evidence registry loader
// ──────────────────────────────────────────────

let _evidenceCache: EvidenceEntry[] | null = null;

export function loadEvidence(): EvidenceEntry[] {
  if (_evidenceCache) return _evidenceCache;
  if (!existsSync(_evidencePath)) {
    console.warn(`[friction-guard] Evidence file not found at ${_evidencePath}`);
    return [];
  }
  const raw = JSON.parse(readFileSync(_evidencePath, "utf8"));
  _evidenceCache = raw.entries as EvidenceEntry[];
  return _evidenceCache;
}

export function getUserEntries(): EvidenceEntry[] {
  return loadEvidence().filter((e) => e.type !== "agent_trigger");
}

export function getAgentEntries(): EvidenceEntry[] {
  return loadEvidence().filter((e) => e.type === "agent_trigger");
}

// ──────────────────────────────────────────────
// Profile management
// ──────────────────────────────────────────────

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function defaultProfile(userId: string): UserProfile {
  return {
    userId,
    updatedAt: new Date().toISOString(),
    signatures: {
      cliche_empathy: 0,
      premature_advice: 0,
      bullet_mismatch: 0,
      over_explain: 0,
      repetition: 0,
      helpdesk_tone: 0,
      confirm_without_deliver: 0,
    },
    constraints: [],
    bannedPhrases: [],
    baseline: {
      avgMessageLength: 80,
      avgSentenceCount: 2,
      greetingPresent: true,
      typicalResponseTimeMs: 5000,
      lastCalibrated: new Date().toISOString(),
      turnCount: 0,
    },
    currentFrictionLevel: 0,
    recentTurnLengths: [],
  };
}

export function readProfile(userId: string): UserProfile {
  ensureDir(_profileDir);
  const path = join(_profileDir, `${userId}.json`);
  if (!existsSync(path)) {
    const profile = defaultProfile(userId);
    writeProfile(profile);
    return profile;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeProfile(profile: UserProfile): void {
  ensureDir(_profileDir);
  const path = join(_profileDir, `${profile.userId}.json`);
  profile.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(profile, null, 2), "utf8");
}

// ──────────────────────────────────────────────
// Constraint inference with decay
// ──────────────────────────────────────────────

let _constraintDecayHours = 48;

export function setConstraintDecayHours(hours: number) {
  _constraintDecayHours = hours;
}

const CONSTRAINT_THRESHOLDS: Record<Signature, { constraint: Constraint; threshold: number }> = {
  cliche_empathy: { constraint: "BAN_CLICHE_PHRASES", threshold: 0.7 },
  premature_advice: { constraint: "NO_UNASKED_ADVICE_EMOTIONAL", threshold: 0.7 },
  bullet_mismatch: { constraint: "DEFAULT_PROSE", threshold: 0.7 },
  over_explain: { constraint: "MAX_LEN_600", threshold: 0.7 },
  helpdesk_tone: { constraint: "NO_HELPDESK", threshold: 0.6 },
  repetition: { constraint: "NO_REPETITION", threshold: 0.6 },
  confirm_without_deliver: { constraint: "EXECUTE_FIRST", threshold: 0.5 },
};

export function inferConstraints(profile: UserProfile) {
  for (const [sig, config] of Object.entries(CONSTRAINT_THRESHOLDS)) {
    const score = profile.signatures[sig as Signature];
    if (score >= config.threshold) {
      enableConstraint(profile, config.constraint, score);
    }
  }

  for (const c of profile.constraints) {
    if (c.lastTriggered) {
      const hoursSince = (Date.now() - new Date(c.lastTriggered).getTime()) / (1000 * 60 * 60);
      if (hoursSince > _constraintDecayHours && c.confidence > 0.3) {
        c.confidence = Math.max(0.3, c.confidence - 0.02);
        if (c.confidence <= 0.3) c.enabled = false;
      }
    }
  }
}

function enableConstraint(profile: UserProfile, id: Constraint, confidence: number) {
  const existing = profile.constraints.find((c) => c.id === id);
  if (existing) {
    existing.enabled = true;
    existing.confidence = Math.min(1, Math.max(existing.confidence, confidence));
    existing.lastTriggered = new Date().toISOString();
  } else {
    profile.constraints.push({
      id,
      enabled: true,
      confidence: Math.min(1, confidence),
      lastTriggered: new Date().toISOString(),
    });
  }
}

// ──────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
