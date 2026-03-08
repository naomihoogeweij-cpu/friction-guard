// ──────────────────────────────────────────────
// Repetition detection for friction-guard
//
// Two detection axes:
// 1. Agent self-repetition: the agent says the same thing across turns
// 2. User forced-repetition: the user has to repeat themselves because
//    the agent didn't register their input
//
// Method: n-gram Jaccard similarity + structural fingerprinting
// No LLM required. Operates on a sliding window of recent turns.
// ──────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TurnRecord {
  timestamp: string;
  source: "user" | "agent";
  text: string;
  ngrams3: Set<string>;
  ngrams2: Set<string>;
  wordSet: Set<string>;
  fingerprint: string; // structural fingerprint
}

export interface RepetitionHistory {
  userId: string;
  updatedAt: string;
  turns: {
    timestamp: string;
    source: "user" | "agent";
    text: string; // stored truncated
  }[];
}

export interface RepetitionResult {
  agentSelfRepetition: {
    detected: boolean;
    highestSimilarity: number;
    repeatedWith?: number; // index of the turn it repeats
  };
  userForcedRepetition: {
    detected: boolean;
    highestSimilarity: number;
    repeatedWith?: number;
  };
}

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

const HISTORY_DIR = join(__dirname, "..", "memory", "turn-history");
const MAX_TURNS = 30; // sliding window
const AGENT_REPETITION_THRESHOLD = 0.55; // Jaccard on trigrams
const USER_REPETITION_THRESHOLD = 0.50;
const MIN_TEXT_LENGTH = 15; // ignore very short messages

// ──────────────────────────────────────────────
// Storage
// ──────────────────────────────────────────────

function historyPath(userId: string): string {
  return join(HISTORY_DIR, `${userId}.json`);
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function readHistory(userId: string): RepetitionHistory {
  ensureDir(HISTORY_DIR);
  const p = historyPath(userId);
  if (!existsSync(p)) {
    return { userId, updatedAt: new Date().toISOString(), turns: [] };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeHistory(history: RepetitionHistory): void {
  ensureDir(HISTORY_DIR);
  history.updatedAt = new Date().toISOString();
  writeFileSync(
    historyPath(history.userId),
    JSON.stringify(history, null, 2),
    "utf8"
  );
}

// ──────────────────────────────────────────────
// Text processing
// ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Dutch
  "de", "het", "een", "en", "van", "in", "is", "dat", "op", "te",
  "voor", "met", "als", "aan", "er", "maar", "om", "ook", "dan",
  "nog", "bij", "uit", "wel", "niet", "naar", "wat", "die", "dit",
  "zo", "al", "was", "ik", "je", "we", "ze", "hij", "zij",
  // English
  "the", "a", "an", "and", "of", "in", "is", "that", "on", "to",
  "for", "with", "as", "at", "but", "or", "also", "then", "still",
  "by", "from", "well", "not", "what", "this", "so", "i", "you",
  "we", "they", "he", "she", "it", "be", "have", "do", "will",
  "can", "would", "should", "could",
]);

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // keep letters, numbers, spaces
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function makeNgrams(tokens: string[], n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    grams.add(tokens.slice(i, i + n).join(" "));
  }
  return grams;
}

function makeWordSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

/**
 * Structural fingerprint: captures the shape of a message
 * without exact content. Useful for detecting reformulations.
 *
 * Format: "L{length_bucket}:S{sentence_count}:Q{has_question}:E{has_exclamation}"
 */
function makeFingerprint(text: string): string {
  const lengthBucket = Math.floor(text.length / 50); // 0-50, 50-100, etc
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const hasQuestion = /\?/.test(text) ? 1 : 0;
  const hasExclamation = /!/.test(text) ? 1 : 0;
  return `L${lengthBucket}:S${sentences.length}:Q${hasQuestion}:E${hasExclamation}`;
}

// ──────────────────────────────────────────────
// Similarity
// ──────────────────────────────────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Combined similarity score using weighted Jaccard across
 * trigrams (most weight), bigrams, and word overlap.
 */
function combinedSimilarity(a: TurnRecord, b: TurnRecord): number {
  const j3 = jaccard(a.ngrams3, b.ngrams3);
  const j2 = jaccard(a.ngrams2, b.ngrams2);
  const jw = jaccard(a.wordSet, b.wordSet);

  // Trigrams carry most weight — they capture phrase-level repetition
  return j3 * 0.5 + j2 * 0.3 + jw * 0.2;
}

// ──────────────────────────────────────────────
// Turn record creation
// ──────────────────────────────────────────────

function makeTurnRecord(
  source: "user" | "agent",
  text: string
): TurnRecord {
  const tokens = tokenize(text);
  return {
    timestamp: new Date().toISOString(),
    source,
    text: text.slice(0, 500),
    ngrams3: makeNgrams(tokens, 3),
    ngrams2: makeNgrams(tokens, 2),
    wordSet: makeWordSet(tokens),
    fingerprint: makeFingerprint(text),
  };
}

// ──────────────────────────────────────────────
// Detection
// ──────────────────────────────────────────────

/**
 * Check agent draft against recent agent turns for self-repetition.
 */
export function detectAgentRepetition(
  draft: string,
  userId: string
): RepetitionResult["agentSelfRepetition"] {
  if (draft.length < MIN_TEXT_LENGTH) {
    return { detected: false, highestSimilarity: 0 };
  }

  const history = readHistory(userId);
  const agentTurns = history.turns
    .filter((t) => t.source === "agent")
    .slice(-10); // last 10 agent turns

  if (agentTurns.length === 0) {
    return { detected: false, highestSimilarity: 0 };
  }

  const current = makeTurnRecord("agent", draft);
  let highest = 0;
  let repeatedWith: number | undefined;

  for (let i = 0; i < agentTurns.length; i++) {
    const past = makeTurnRecord("agent", agentTurns[i].text);
    const sim = combinedSimilarity(current, past);
    if (sim > highest) {
      highest = sim;
      repeatedWith = i;
    }
  }

  return {
    detected: highest >= AGENT_REPETITION_THRESHOLD,
    highestSimilarity: highest,
    repeatedWith: highest >= AGENT_REPETITION_THRESHOLD ? repeatedWith : undefined,
  };
}

/**
 * Check if user is being forced to repeat themselves —
 * their current message is too similar to a recent message of theirs.
 */
export function detectUserForcedRepetition(
  userText: string,
  userId: string
): RepetitionResult["userForcedRepetition"] {
  if (userText.length < MIN_TEXT_LENGTH) {
    return { detected: false, highestSimilarity: 0 };
  }

  const history = readHistory(userId);
  const userTurns = history.turns
    .filter((t) => t.source === "user")
    .slice(-10);

  if (userTurns.length === 0) {
    return { detected: false, highestSimilarity: 0 };
  }

  const current = makeTurnRecord("user", userText);
  let highest = 0;
  let repeatedWith: number | undefined;

  for (let i = 0; i < userTurns.length; i++) {
    const past = makeTurnRecord("user", userTurns[i].text);
    const sim = combinedSimilarity(current, past);
    if (sim > highest) {
      highest = sim;
      repeatedWith = i;
    }
  }

  return {
    detected: highest >= USER_REPETITION_THRESHOLD,
    highestSimilarity: highest,
    repeatedWith: highest >= USER_REPETITION_THRESHOLD ? repeatedWith : undefined,
  };
}

/**
 * Run both detection axes.
 */
export function detectRepetition(
  text: string,
  source: "user" | "agent",
  userId: string
): RepetitionResult {
  if (source === "agent") {
    return {
      agentSelfRepetition: detectAgentRepetition(text, userId),
      userForcedRepetition: { detected: false, highestSimilarity: 0 },
    };
  } else {
    return {
      agentSelfRepetition: { detected: false, highestSimilarity: 0 },
      userForcedRepetition: detectUserForcedRepetition(text, userId),
    };
  }
}

// ──────────────────────────────────────────────
// History management
// ──────────────────────────────────────────────

export function recordTurn(
  userId: string,
  source: "user" | "agent",
  text: string
): void {
  const history = readHistory(userId);

  history.turns.push({
    timestamp: new Date().toISOString(),
    source,
    text: text.slice(0, 500),
  });

  // Keep sliding window
  if (history.turns.length > MAX_TURNS) {
    history.turns = history.turns.slice(-MAX_TURNS);
  }

  writeHistory(history);
}

// ──────────────────────────────────────────────
// Phrase-level repetition (for agent output)
//
// Detects specific repeated phrases/sentences
// across agent turns — more granular than full-turn
// similarity. Returns phrases that appeared in 2+
// recent agent turns.
// ──────────────────────────────────────────────

export function findRepeatedAgentPhrases(
  draft: string,
  userId: string
): string[] {
  const history = readHistory(userId);
  const agentTurns = history.turns
    .filter((t) => t.source === "agent")
    .slice(-5);

  if (agentTurns.length === 0) return [];

  // Extract sentences from draft
  const draftSentences = draft
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20); // only meaningful sentences

  const repeated: string[] = [];

  for (const sentence of draftSentences) {
    const sentenceTokens = tokenize(sentence);
    const sentenceGrams = makeNgrams(sentenceTokens, 3);

    for (const past of agentTurns) {
      const pastTokens = tokenize(past.text);
      const pastGrams = makeNgrams(pastTokens, 3);
      const sim = jaccard(sentenceGrams, pastGrams);

      if (sim > 0.6) {
        repeated.push(sentence);
        break; // don't count same sentence twice
      }
    }
  }

  return repeated;
}
