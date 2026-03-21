// ──────────────────────────────────────────────
// Retroactive Agent Pattern Mining (Option 1)
//
// Purely statistical, no LLM required.
//
// Compares n-grams in agent responses that
// preceded user friction (level 2+) with n-grams
// in agent responses that preceded calm (level 0)
// interactions. N-grams that appear significantly
// more often before friction are candidate
// irritation patterns.
//
// Runs alongside the background analysis cycle.
// After sufficient data (configurable), promotes
// high-confidence patterns to dynamic bans.
// ──────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface NgramStats {
  frictionCount: number;   // times seen before friction (level 2+)
  calmCount: number;       // times seen before calm (level 0)
  totalCount: number;
  lastSeen: string;
  firstSeen: string;
}

interface PatternCandidate {
  ngram: string;
  frictionRate: number;    // frictionCount / totalCount
  lift: number;            // how much more likely before friction than baseline
  frictionCount: number;
  calmCount: number;
  totalCount: number;
  firstSeen: string;
  lastSeen: string;
}

interface MinerState {
  lastRun: string;
  totalPairsProcessed: number;
  baselineFrictionRate: number;   // overall friction rate across all pairs
  ngramStats: Record<string, NgramStats>;
  promotedPatterns: string[];
}

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

const STATE_DIR = join(__dirname, "..", "memory", "pattern-miner");
const STATE_FILE = join(STATE_DIR, "miner-state.json");
const INCIDENT_DIR = join(__dirname, "..", "memory", "incident-logs");
const HISTORY_DIR = join(__dirname, "..", "memory", "turn-history");

// N-gram sizes to extract
const NGRAM_SIZES = [2, 3, 4]; // bigrams, trigrams, 4-grams

// Minimum observations before a pattern is considered
const MIN_OBSERVATIONS = 5;

// Minimum lift (how much more likely before friction than baseline)
const MIN_LIFT = 2.0;

// Minimum friction rate (at least 60% of occurrences precede friction)
const MIN_FRICTION_RATE = 0.6;

// Minimum n-gram length in characters (filter out trivial matches)
const MIN_NGRAM_CHARS = 8;

// Stop words to filter from n-grams (function words that appear everywhere)
const STOP_WORDS_NL = new Set([
  "de", "het", "een", "en", "van", "in", "is", "dat", "op", "te",
  "voor", "er", "met", "als", "zijn", "aan", "dit", "die", "maar",
  "om", "ook", "naar", "dan", "nog", "bij", "uit", "wel", "wat",
  "je", "ik", "we", "ze", "hij", "niet", "kan", "al", "meer",
]);

const STOP_WORDS_EN = new Set([
  "the", "a", "an", "and", "of", "in", "is", "that", "on", "to",
  "for", "it", "with", "as", "are", "this", "but", "or", "be",
  "at", "by", "from", "was", "have", "has", "had", "will", "can",
  "do", "if", "not", "so", "no", "all", "you", "i", "we", "they",
  "my", "your", "our", "just", "very", "really", "also", "been",
]);

// ──────────────────────────────────────────────
// State management
// ──────────────────────────────────────────────

function loadMinerState(): MinerState {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }
  }
  return {
    lastRun: new Date(0).toISOString(),
    totalPairsProcessed: 0,
    baselineFrictionRate: 0,
    ngramStats: {},
    promotedPatterns: [],
  };
}

function saveMinerState(state: MinerState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ──────────────────────────────────────────────
// N-gram extraction
// ──────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // keep letters/numbers/spaces
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function extractNgrams(text: string, sizes: number[]): string[] {
  const tokens = tokenize(text);
  const ngrams: string[] = [];

  for (const n of sizes) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const gram = tokens.slice(i, i + n);

      // Skip if all tokens are stop words
      const nonStop = gram.filter(
        (t) => !STOP_WORDS_NL.has(t) && !STOP_WORDS_EN.has(t)
      );
      if (nonStop.length === 0) continue;

      const joined = gram.join(" ");

      // Skip trivially short n-grams
      if (joined.length < MIN_NGRAM_CHARS) continue;

      ngrams.push(joined);
    }
  }

  // Deduplicate within a single text
  return [...new Set(ngrams)];
}

// ──────────────────────────────────────────────
// Pair extraction
//
// For each user turn in turn-history, determine:
// 1. What the agent said just before
// 2. Whether the user turn was a friction event
//
// A user turn is "friction" if it appears in the
// incident log at level 2+. Otherwise it's "calm".
// ──────────────────────────────────────────────

interface TurnPair {
  agentText: string;
  isFriction: boolean;
}

function loadFrictionTimestamps(userId: string): Set<string> {
  const stamps = new Set<string>();
  if (!existsSync(INCIDENT_DIR)) return stamps;

  const files = readdirSync(INCIDENT_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const log = JSON.parse(readFileSync(join(INCIDENT_DIR, file), "utf8"));
      for (const frag of log.fragments || []) {
        if (frag.userId === userId && frag.level >= 2) {
          stamps.add(frag.timestamp);
        }
      }
    } catch { /* skip */ }
  }
  return stamps;
}

function extractPairsForUser(userId: string): TurnPair[] {
  const historyFile = join(HISTORY_DIR, `${userId}.json`);
  if (!existsSync(historyFile)) return [];

  let history;
  try {
    history = JSON.parse(readFileSync(historyFile, "utf8"));
  } catch {
    return [];
  }

  const turns = history.turns || [];
  const frictionTimestamps = loadFrictionTimestamps(userId);
  const pairs: TurnPair[] = [];

  for (let i = 1; i < turns.length; i++) {
    const current = turns[i];
    const prev = turns[i - 1];

    // We want: prev = agent, current = user
    if (prev.source !== "agent" || current.source !== "user") continue;
    if (!prev.text || !current.text) continue;

    // Check if the user turn was a friction event
    const isFriction = frictionTimestamps.has(current.timestamp);

    pairs.push({
      agentText: prev.text,
      isFriction,
    });
  }

  return pairs;
}

// ──────────────────────────────────────────────
// Mining run
// ──────────────────────────────────────────────

export function runPatternMining(): {
  pairsProcessed: number;
  newCandidates: number;
  promoted: string[];
} {
  const state = loadMinerState();
  const now = new Date().toISOString();

  // Collect pairs from all users in turn-history
  if (!existsSync(HISTORY_DIR)) {
    return { pairsProcessed: 0, newCandidates: 0, promoted: [] };
  }

  const userFiles = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  let totalPairs = 0;
  let frictionPairs = 0;

  for (const file of userFiles) {
    const userId = file.replace(".json", "");
    const pairs = extractPairsForUser(userId);

    for (const pair of pairs) {
      totalPairs++;
      if (pair.isFriction) frictionPairs++;

      const ngrams = extractNgrams(pair.agentText, NGRAM_SIZES);

      for (const ngram of ngrams) {
        if (!state.ngramStats[ngram]) {
          state.ngramStats[ngram] = {
            frictionCount: 0,
            calmCount: 0,
            totalCount: 0,
            firstSeen: now,
            lastSeen: now,
          };
        }

        const stats = state.ngramStats[ngram];
        stats.totalCount++;
        stats.lastSeen = now;

        if (pair.isFriction) {
          stats.frictionCount++;
        } else {
          stats.calmCount++;
        }
      }
    }
  }

  // Update baseline friction rate
  if (totalPairs > 0) {
    state.baselineFrictionRate = frictionPairs / totalPairs;
  }

  // Evaluate candidates for promotion
  const promoted: string[] = [];
  let newCandidates = 0;

  for (const [ngram, stats] of Object.entries(state.ngramStats)) {
    if (stats.totalCount < MIN_OBSERVATIONS) continue;
    if (state.promotedPatterns.includes(ngram)) continue;

    const frictionRate = stats.frictionCount / stats.totalCount;
    const baseRate = state.baselineFrictionRate || 0.1;
    const lift = frictionRate / baseRate;

    if (frictionRate >= MIN_FRICTION_RATE && lift >= MIN_LIFT) {
      state.promotedPatterns.push(ngram);
      promoted.push(ngram);
      newCandidates++;
      console.info(
        `[friction-guard] Pattern miner promoted: "${ngram}" ` +
        `(friction rate ${(frictionRate * 100).toFixed(0)}%, lift ${lift.toFixed(1)}x, ` +
        `${stats.frictionCount}/${stats.totalCount} observations)`
      );
    }
  }

  // Housekeeping: prune n-grams with low counts and old lastSeen
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  for (const [ngram, stats] of Object.entries(state.ngramStats)) {
    if (stats.totalCount < 2 && stats.lastSeen < thirtyDaysAgo) {
      delete state.ngramStats[ngram];
    }
  }

  state.lastRun = now;
  state.totalPairsProcessed += totalPairs;
  saveMinerState(state);

  return { pairsProcessed: totalPairs, newCandidates, promoted };
}

// ──────────────────────────────────────────────
// Retrieval
// ──────────────────────────────────────────────

/**
 * Get patterns promoted by the miner — these
 * are merged into the ban list alongside
 * LLM-classifier promoted bans.
 */
export function getMinedPatterns(): string[] {
  return loadMinerState().promotedPatterns;
}

/**
 * Get top candidates (not yet promoted) for
 * manual inspection.
 */
export function getMinerCandidates(limit = 20): PatternCandidate[] {
  const state = loadMinerState();
  const baseRate = state.baselineFrictionRate || 0.1;

  const candidates: PatternCandidate[] = [];

  for (const [ngram, stats] of Object.entries(state.ngramStats)) {
    if (stats.totalCount < 3) continue; // need some data
    if (state.promotedPatterns.includes(ngram)) continue;

    const frictionRate = stats.frictionCount / stats.totalCount;
    const lift = frictionRate / baseRate;

    candidates.push({
      ngram,
      frictionRate,
      lift,
      frictionCount: stats.frictionCount,
      calmCount: stats.calmCount,
      totalCount: stats.totalCount,
      firstSeen: stats.firstSeen,
      lastSeen: stats.lastSeen,
    });
  }

  return candidates
    .sort((a, b) => b.lift - a.lift)
    .slice(0, limit);
}

export function getMinerStats(): {
  lastRun: string;
  totalPairsProcessed: number;
  baselineFrictionRate: number;
  totalNgrams: number;
  promotedCount: number;
} {
  const state = loadMinerState();
  return {
    lastRun: state.lastRun,
    totalPairsProcessed: state.totalPairsProcessed,
    baselineFrictionRate: state.baselineFrictionRate,
    totalNgrams: Object.keys(state.ngramStats).length,
    promotedCount: state.promotedPatterns.length,
  };
}
