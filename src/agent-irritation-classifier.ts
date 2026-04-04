// ──────────────────────────────────────────────
// Agent Irritation Classifier (Option 3)
//
// Runs periodically (daily). Collects agent
// responses that preceded user friction events,
// sends them to LLM for classification, and
// promotes consistently problematic phrases
// to dynamic bans.
// ──────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface FrictionPair { userId: string; agentText: string; userText: string; frictionLevel: number; markers: string[]; timestamp: string; }
interface ClassifiedPhrase { phrase: string; category: string; reason: string; severity: number; observedCount: number; firstSeen: string; lastSeen: string; }
interface ClassifierState { lastRun: string; totalPairsAnalyzed: number; candidates: ClassifiedPhrase[]; promotedBans: string[]; }

const STATE_DIR = join(__dirname, "..", "memory", "classifier");
const STATE_FILE = join(STATE_DIR, "classifier-state.json");
const INCIDENT_DIR = join(__dirname, "..", "memory", "incident-logs");
const HISTORY_DIR = join(__dirname, "..", "memory", "turn-history");
const MIN_FRICTION_LEVEL = 2;
const PROMOTION_THRESHOLD = 3;
const MAX_PAIRS_PER_RUN = 10;

function loadState(): ClassifierState {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ } }
  return { lastRun: new Date(0).toISOString(), totalPairsAnalyzed: 0, candidates: [], promotedBans: [] };
}

function saveState(state: ClassifierState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractFrictionPairs(since: string): FrictionPair[] {
  const pairs: FrictionPair[] = [];
  if (!existsSync(INCIDENT_DIR)) return pairs;
  const logFiles = readdirSync(INCIDENT_DIR).filter((f: string) => f.endsWith(".json"));
  for (const file of logFiles) {
    try {
      const log = JSON.parse(readFileSync(join(INCIDENT_DIR, file), "utf8"));
      for (const frag of (log.fragments || [])) {
        if (frag.level < MIN_FRICTION_LEVEL) continue;
        if (new Date(frag.timestamp) <= new Date(since)) continue;
        const agentText = findPrecedingAgentTurn(frag.userId, frag.timestamp);
        if (!agentText) continue;
        pairs.push({ userId: frag.userId, agentText, userText: frag.text || "", frictionLevel: frag.level, markers: frag.markers || [], timestamp: frag.timestamp });
      }
    } catch { /* skip */ }
  }
  pairs.sort((a, b) => b.frictionLevel - a.frictionLevel);
  return pairs.slice(0, MAX_PAIRS_PER_RUN);
}

function findPrecedingAgentTurn(userId: string, beforeTimestamp: string): string | null {
  const historyFile = join(HISTORY_DIR, `${userId}.json`);
  if (!existsSync(historyFile)) return null;
  try {
    const history = JSON.parse(readFileSync(historyFile, "utf8"));
    const before = new Date(beforeTimestamp).getTime();
    let bestAgent: string | null = null; let bestTime = 0;
    for (const turn of (history.turns || [])) { if (turn.source !== "agent") continue; const t = new Date(turn.timestamp).getTime(); if (t < before && t > bestTime) { bestTime = t; bestAgent = turn.text; } }
    return bestAgent;
  } catch { return null; }
}

function buildClassificationPrompt(pairs: FrictionPair[]): string {
  const pairText = pairs.map((p, i) => `--- Pair ${i + 1} (friction level ${p.frictionLevel}) ---\nAGENT said:\n${p.agentText.slice(0, 500)}\n\nUSER reacted (irritated):\n${p.userText.slice(0, 300)}\n`).join("\n\n");
  return `You are an interaction quality analyst. Below are pairs of (agent response, irritated user reaction).\n\nFor each pair, identify specific phrases in the AGENT's response that likely caused irritation. Classify into:\n- sycophancy, fake_humanity, helpdesk_filler, overexplanation, incorrect_repair, emotional_incongruence, premature_solutioning\n\nRespond ONLY with a JSON array:\n[{"phrase":"exact substring","category":"one of 7","reason":"one sentence","severity":0.3-0.9}]\n\nNo preamble, no markdown fences.\n\n${pairText}`;
}

export async function runClassification(modelCall: (prompt: string) => Promise<string>): Promise<{ newCandidates: number; promoted: string[] }> {
  const state = loadState();
  const pairs = extractFrictionPairs(state.lastRun);
  if (pairs.length === 0) { state.lastRun = new Date().toISOString(); saveState(state); return { newCandidates: 0, promoted: [] }; }
  let responseText: string;
  try { responseText = await modelCall(buildClassificationPrompt(pairs)); }
  catch (e) { console.warn("[friction-guard] Classifier LLM call failed:", e); return { newCandidates: 0, promoted: [] }; }
  let classified: Array<{ phrase: string; category: string; reason: string; severity: number }> = [];
  try { const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim(); classified = JSON.parse(cleaned); if (!Array.isArray(classified)) classified = []; }
  catch { console.warn("[friction-guard] Classifier response not valid JSON"); return { newCandidates: 0, promoted: [] }; }
  let newCount = 0; const now = new Date().toISOString();
  for (const item of classified) {
    if (!item.phrase || !item.category) continue;
    const norm = item.phrase.toLowerCase().trim();
    const existing = state.candidates.find((c) => c.phrase.toLowerCase().trim() === norm);
    if (existing) { existing.observedCount++; existing.lastSeen = now; existing.severity = (existing.severity * (existing.observedCount - 1) + (item.severity || 0.5)) / existing.observedCount; }
    else { state.candidates.push({ phrase: item.phrase, category: item.category, reason: item.reason || "", severity: item.severity || 0.5, observedCount: 1, firstSeen: now, lastSeen: now }); newCount++; }
  }
  const promoted: string[] = [];
  for (const c of state.candidates) { if (c.observedCount >= PROMOTION_THRESHOLD && !state.promotedBans.includes(c.phrase)) { state.promotedBans.push(c.phrase); promoted.push(c.phrase); console.info(`[friction-guard] Promoted to dynamic ban: "${c.phrase}" (${c.category}, ${c.observedCount}x, severity ${c.severity.toFixed(2)})`); } }
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  state.candidates = state.candidates.filter((c) => c.lastSeen > thirtyDaysAgo);
  state.lastRun = now; state.totalPairsAnalyzed += pairs.length; saveState(state);
  return { newCandidates: newCount, promoted };
}

export function getPromotedBans(): string[] { return loadState().promotedBans; }
export function getCandidates(): ClassifiedPhrase[] { return loadState().candidates.sort((a, b) => b.observedCount - a.observedCount); }
export function getClassifierStats() {
  const state = loadState();
  return { lastRun: state.lastRun, totalPairsAnalyzed: state.totalPairsAnalyzed, candidateCount: state.candidates.length, promotedCount: state.promotedBans.length,
    topCandidates: state.candidates.sort((a, b) => b.observedCount - a.observedCount).slice(0, 10).map((c) => ({ phrase: c.phrase, count: c.observedCount, category: c.category })) };
}
