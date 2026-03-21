// ──────────────────────────────────────────────
// Agent Irritation Classifier (Option 3)
//
// Runs periodically (daily or on-demand).
// Collects agent responses that preceded user
// friction events, sends them to the LLM for
// classification, and promotes consistently
// problematic phrases to dynamic bans.
//
// Architecture:
//   incident-log → turn-history → pair extraction
//   → LLM classification → candidate bank
//   → promotion threshold → dynamic bans
// ──────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface FrictionPair {
  userId: string;
  agentText: string;
  userText: string;
  frictionLevel: number;
  markers: string[];
  timestamp: string;
}

interface ClassifiedPhrase {
  phrase: string;
  category: string;
  reason: string;
  severity: number;
  observedCount: number;
  firstSeen: string;
  lastSeen: string;
}

interface ClassifierState {
  lastRun: string;
  totalPairsAnalyzed: number;
  candidates: ClassifiedPhrase[];
  promotedBans: string[];
}

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

const STATE_DIR = join(__dirname, "..", "memory", "classifier");
const STATE_FILE = join(STATE_DIR, "classifier-state.json");
const INCIDENT_DIR = join(__dirname, "..", "memory", "incident-logs");
const HISTORY_DIR = join(__dirname, "..", "memory", "turn-history");

// Minimum friction level to consider a pair worth analyzing
const MIN_FRICTION_LEVEL = 2;

// How many times a phrase must be flagged before promotion to ban
const PROMOTION_THRESHOLD = 3;

// Max pairs to analyze per run (cost control)
const MAX_PAIRS_PER_RUN = 10;

// ──────────────────────────────────────────────
// State management
// ──────────────────────────────────────────────

function loadState(): ClassifierState {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      // corrupted state, start fresh
    }
  }
  return {
    lastRun: new Date(0).toISOString(),
    totalPairsAnalyzed: 0,
    candidates: [],
    promotedBans: [],
  };
}

function saveState(state: ClassifierState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ──────────────────────────────────────────────
// Pair extraction
//
// Walk the incident logs for friction events,
// then look up the preceding agent turn from
// turn history.
// ──────────────────────────────────────────────

function extractFrictionPairs(since: string): FrictionPair[] {
  const pairs: FrictionPair[] = [];

  // Read incident logs
  if (!existsSync(INCIDENT_DIR)) return pairs;
  const logFiles = require("node:fs")
    .readdirSync(INCIDENT_DIR)
    .filter((f: string) => f.endsWith(".json"));

  for (const file of logFiles) {
    try {
      const log = JSON.parse(readFileSync(join(INCIDENT_DIR, file), "utf8"));
      const fragments = log.fragments || [];

      for (const frag of fragments) {
        if (frag.level < MIN_FRICTION_LEVEL) continue;
        if (new Date(frag.timestamp) <= new Date(since)) continue;

        // Find the preceding agent turn
        const agentText = findPrecedingAgentTurn(frag.userId, frag.timestamp);
        if (!agentText) continue;

        pairs.push({
          userId: frag.userId,
          agentText,
          userText: frag.text || "",
          frictionLevel: frag.level,
          markers: frag.markers || [],
          timestamp: frag.timestamp,
        });
      }
    } catch {
      // skip malformed log files
    }
  }

  // Sort by friction level descending, take top N
  pairs.sort((a, b) => b.frictionLevel - a.frictionLevel);
  return pairs.slice(0, MAX_PAIRS_PER_RUN);
}

function findPrecedingAgentTurn(userId: string, beforeTimestamp: string): string | null {
  const historyFile = join(HISTORY_DIR, `${userId}.json`);
  if (!existsSync(historyFile)) return null;

  try {
    const history = JSON.parse(readFileSync(historyFile, "utf8"));
    const turns = history.turns || [];
    const before = new Date(beforeTimestamp).getTime();

    // Find the most recent agent turn before the friction event
    let bestAgent: string | null = null;
    let bestTime = 0;

    for (const turn of turns) {
      if (turn.source !== "agent") continue;
      const t = new Date(turn.timestamp).getTime();
      if (t < before && t > bestTime) {
        bestTime = t;
        bestAgent = turn.text;
      }
    }

    return bestAgent;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// LLM classification prompt
//
// Sends agent-response + user-friction-response
// pairs to the model for analysis. The model
// identifies specific phrases in the agent's
// response that likely caused irritation.
// ──────────────────────────────────────────────

function buildClassificationPrompt(pairs: FrictionPair[]): string {
  const pairText = pairs
    .map(
      (p, i) =>
        `--- Pair ${i + 1} (friction level ${p.frictionLevel}) ---\n` +
        `AGENT said:\n${p.agentText.slice(0, 500)}\n\n` +
        `USER reacted (irritated):\n${p.userText.slice(0, 300)}\n`
    )
    .join("\n\n");

  return `You are an interaction quality analyst. Below are pairs of (agent response, irritated user reaction). The user's reaction indicates friction — something in the agent's response annoyed them.

For each pair, identify the specific phrases in the AGENT's response that likely caused the irritation. Classify each phrase into one of these categories:
- sycophancy: false validation, excessive agreement
- fake_humanity: performative empathy without substance
- helpdesk_filler: empty service-desk language
- overexplanation: paternalistic over-elaboration
- incorrect_repair: acknowledging error without fixing it
- emotional_incongruence: wrong register for the emotional context
- premature_solutioning: jumping to fixes before listening

Respond ONLY with a JSON array. Each element:
{
  "phrase": "the exact problematic phrase from the agent's text",
  "category": "one of the 7 categories above",
  "reason": "one sentence explaining why this phrase causes friction",
  "severity": 0.3-0.9
}

If no problematic phrases are found in a pair, skip it. Do not invent phrases that aren't in the agent's text. Be precise — extract the exact substring.

${pairText}

Respond with ONLY the JSON array, no preamble, no markdown fences.`;
}

// ──────────────────────────────────────────────
// Classification execution
//
// This function is designed to be called by the
// background analysis module or by a cron job.
// It needs access to an LLM API — either through
// OpenClaw's model access or a direct API call.
//
// The caller provides a function that takes a
// prompt and returns the model's response text.
// ──────────────────────────────────────────────

export async function runClassification(
  modelCall: (prompt: string) => Promise<string>
): Promise<{ newCandidates: number; promoted: string[] }> {
  const state = loadState();
  const pairs = extractFrictionPairs(state.lastRun);

  if (pairs.length === 0) {
    state.lastRun = new Date().toISOString();
    saveState(state);
    return { newCandidates: 0, promoted: [] };
  }

  const prompt = buildClassificationPrompt(pairs);
  let responseText: string;

  try {
    responseText = await modelCall(prompt);
  } catch (e) {
    console.warn("[friction-guard] Classifier LLM call failed:", e);
    return { newCandidates: 0, promoted: [] };
  }

  // Parse response
  let classified: Array<{
    phrase: string;
    category: string;
    reason: string;
    severity: number;
  }> = [];

  try {
    // Strip potential markdown fences
    const cleaned = responseText
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    classified = JSON.parse(cleaned);
    if (!Array.isArray(classified)) classified = [];
  } catch {
    console.warn("[friction-guard] Classifier response not valid JSON");
    return { newCandidates: 0, promoted: [] };
  }

  // Merge into candidates
  let newCount = 0;
  const now = new Date().toISOString();

  for (const item of classified) {
    if (!item.phrase || !item.category) continue;

    const normalizedPhrase = item.phrase.toLowerCase().trim();
    const existing = state.candidates.find(
      (c) => c.phrase.toLowerCase().trim() === normalizedPhrase
    );

    if (existing) {
      existing.observedCount++;
      existing.lastSeen = now;
      // Update severity as running average
      existing.severity =
        (existing.severity * (existing.observedCount - 1) + (item.severity || 0.5)) /
        existing.observedCount;
    } else {
      state.candidates.push({
        phrase: item.phrase,
        category: item.category,
        reason: item.reason || "",
        severity: item.severity || 0.5,
        observedCount: 1,
        firstSeen: now,
        lastSeen: now,
      });
      newCount++;
    }
  }

  // Promote candidates that crossed the threshold
  const promoted: string[] = [];
  for (const candidate of state.candidates) {
    if (
      candidate.observedCount >= PROMOTION_THRESHOLD &&
      !state.promotedBans.includes(candidate.phrase)
    ) {
      state.promotedBans.push(candidate.phrase);
      promoted.push(candidate.phrase);
      console.info(
        `[friction-guard] Promoted to dynamic ban: "${candidate.phrase}" ` +
          `(${candidate.category}, observed ${candidate.observedCount}x, severity ${candidate.severity.toFixed(2)})`
      );
    }
  }

  // Housekeeping: trim old candidates (not seen in 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  state.candidates = state.candidates.filter((c) => c.lastSeen > thirtyDaysAgo);

  state.lastRun = now;
  state.totalPairsAnalyzed += pairs.length;
  saveState(state);

  return { newCandidates: newCount, promoted };
}

// ──────────────────────────────────────────────
// Dynamic ban retrieval
//
// Called by the main plugin to get phrases that
// the classifier has promoted to bans.
// ──────────────────────────────────────────────

export function getPromotedBans(): string[] {
  const state = loadState();
  return state.promotedBans;
}

// ──────────────────────────────────────────────
// Manual inspection
//
// Returns current candidates for review.
// ──────────────────────────────────────────────

export function getCandidates(): ClassifiedPhrase[] {
  const state = loadState();
  return state.candidates.sort((a, b) => b.observedCount - a.observedCount);
}

export function getClassifierStats(): {
  lastRun: string;
  totalPairsAnalyzed: number;
  candidateCount: number;
  promotedCount: number;
  topCandidates: Array<{ phrase: string; count: number; category: string }>;
} {
  const state = loadState();
  return {
    lastRun: state.lastRun,
    totalPairsAnalyzed: state.totalPairsAnalyzed,
    candidateCount: state.candidates.length,
    promotedCount: state.promotedBans.length,
    topCandidates: state.candidates
      .sort((a, b) => b.observedCount - a.observedCount)
      .slice(0, 10)
      .map((c) => ({ phrase: c.phrase, count: c.observedCount, category: c.category })),
  };
}
