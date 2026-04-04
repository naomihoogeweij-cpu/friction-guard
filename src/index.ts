// ──────────────────────────────────────────────
// friction-guard — OpenClaw plugin
// v4.0.0
//
// Evidence-based interaction friction detection
// and pre-generation constraint injection.
//
// https://github.com/naomihoogeweij-cpu/friction-guard
// ──────────────────────────────────────────────

import {
  readProfile, writeProfile, inferConstraints, getUserEntries, getAgentEntries,
  loadEvidence, configurePaths, setConstraintDecayHours, clamp01, escapeRegExp,
  type UserProfile, type EvidenceEntry, type FrictionLevel, type Constraint,
  type Signature, type FrictionGuardConfig,
} from "../../workspace/interaction/friction-policy";
import { logFragment } from "../../workspace/interaction/incident-log";
import { detectUserForcedRepetition, findRepeatedAgentPhrases, recordTurn, readHistory } from "../../workspace/interaction/repetition-detection";
import { runBackgroundAnalysis } from "../../workspace/interaction/background-analysis";
import { loadGrievanceDictionary, matchGrievance, grievanceFrictionLevel, grievanceConstraints, grievanceSignatureUpdates } from "../../workspace/interaction/grievance-matching";
import { loadAgentIrritationRegistry, matchAgentIrritation, agentIrritationConstraints, agentIrritationBanPhrases } from "../../workspace/interaction/agent-irritation-matching";
import { getPromotedBans, runClassification, getClassifierStats } from "../../workspace/interaction/agent-irritation-classifier";
import { runPatternMining, getMinedPatterns } from "../../workspace/interaction/agent-pattern-miner";
import { loadPrimingExamples, buildColdStartPrompt, isColdStart } from "../../workspace/interaction/cold-start-priming";

import { appendFileSync, mkdirSync, readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { exec } from "node:child_process";
import { join, dirname } from "node:path";

// --- Action avoidance detection ---
const ACTION_AVOIDANCE_PATTERNS_NL = [
  "ja, dat had ik moeten doen", "klopt, dat ga ik nu", "dat is helder", "goed punt, ik ga",
  "je hebt gelijk, ik moet", "ik ga dat nu nalopen", "eens, dat had niet", "inderdaad, dat moet",
  "dat is nu opgeslagen", "dat klopt, en ik had",
];
const ACTION_AVOIDANCE_PATTERNS_EN = [
  "yes, i should have done that", "good point, i will", "you're right, i need to",
  "i'm going to do that now", "understood, i will", "noted, i should have",
];

function detectActionAvoidanceLoop(userId: string, lang: "nl" | "en"): boolean {
  try {
    const sessionsPath = join(process.env.HOME || "/root", ".openclaw", "agents", "main", "sessions", "sessions.json");
    const sessionsData = JSON.parse(readFileSync(sessionsPath, "utf8"));
    let sessionId: string | null = null;
    for (const [key, val] of Object.entries(sessionsData)) {
      const v = val as any;
      if (key.includes(userId) || key === "agent:main:main") { sessionId = v.sessionId; if (key.includes(userId)) break; }
    }
    if (!sessionId) return false;
    const transcriptPath = join(process.env.HOME || "/root", ".openclaw", "agents", "main", "sessions", sessionId + ".jsonl");
    if (!existsSync(transcriptPath)) return false;
    const fd = openSync(transcriptPath, "r"); const stats = fstatSync(fd);
    const readSize = Math.min(stats.size, 8192); const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize)); closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
    const agentTexts: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line); const msg = entry?.message;
        if (!msg || msg.role !== "assistant") continue;
        let text = "";
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content)) { const tp = msg.content.find((p: any) => p.type === "text" && typeof p.text === "string"); if (tp) text = tp.text; }
        if (text.length > 10) agentTexts.push(text.slice(0, 500));
      } catch {}
    }
    if (agentTexts.length < 2) return false;
    const patterns = lang === "nl" ? ACTION_AVOIDANCE_PATTERNS_NL : ACTION_AVOIDANCE_PATTERNS_EN;
    let matches = 0;
    for (const text of agentTexts.slice(-3)) { if (patterns.some(p => text.toLowerCase().includes(p))) matches++; }
    return matches >= 2;
  } catch { return false; }
}

// --- Semantic expansion cache ---
const SEMANTIC_DIR = join(process.env.HOME || "/root", ".openclaw", "workspace", "memory", "semantic");
const EXPANDED_BANS_PATH = join(SEMANTIC_DIR, "expanded-bans.json");
const SEMANTIC_SCRIPT = join(process.env.HOME || "/root", ".openclaw", "workspace", "interaction", "semantic-expansion.py");

function loadExpandedBanVariants(): string[] {
  if (!existsSync(EXPANDED_BANS_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(EXPANDED_BANS_PATH, "utf8"));
    const variants: string[] = [];
    for (const expansion of Object.values(data.expansions || {})) {
      for (const v of (expansion as any[])) variants.push(v.phrase);
    }
    return variants;
  } catch { return []; }
}

function triggerSemanticRefresh(logger: any) {
  if (!existsSync(SEMANTIC_SCRIPT)) return;
  exec(`python3 ${SEMANTIC_SCRIPT} refresh`, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) { logger.warn("[friction-guard] Semantic refresh error:", err.message); return; }
    if (stdout.trim()) logger.info("[friction-guard] Semantic: " + stdout.trim().split("\n").pop());
  });
}

// --- Central error logging ---
const ERROR_LOG_PATH = join(process.env.HOME || "/root", ".openclaw", "workspace", "memory", "error-log.jsonl");

function logErrorToFile(category: string, summary: string) {
  const entry = JSON.stringify({ ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), category, summary: String(summary).slice(0, 300), escalated: false, source: "friction-guard" });
  try { mkdirSync(dirname(ERROR_LOG_PATH), { recursive: true }); appendFileSync(ERROR_LOG_PATH, entry + "\n"); } catch (_) {}
}

let BACKGROUND_INTERVAL_MS = 15 * 60 * 1000;
let CLASSIFIER_INTERVAL_MS = 24 * 60 * 60 * 1000;
let MAX_RESPONSE_LENGTH = 600;
let BAN_TTL_MS = 2 * 60 * 60 * 1000;
const BASELINE_WINDOW = 10;
const SIGNATURE_INCREMENT: Record<number, number> = { 0: 0, 1: 0.03, 2: 0.08, 3: 0.15 };
let _lastBackgroundRun = 0;
let _lastClassifierRun = 0;

function detectLanguage(text: string, defaultLang: string = "en"): "nl" | "en" {
  const nlMarkers = /\b(ik|je|het|een|dat|niet|maar|ook|wel|nog|van|voor|naar|dit|wat)\b/gi;
  return (text.match(nlMarkers) || []).length >= 2 ? "nl" : defaultLang as "nl" | "en";
}

function matchUserInput(userText: string, lang: string): { entry: EvidenceEntry; matched: string }[] {
  const lowered = userText.toLowerCase();
  const results: { entry: EvidenceEntry; matched: string }[] = [];
  for (const entry of getUserEntries()) {
    if (entry.detection === "computed" || !entry.patterns) continue;
    for (const phrase of (entry.patterns[lang] || entry.patterns["en"] || [])) {
      if (lowered.includes(phrase.toLowerCase())) { results.push({ entry, matched: phrase }); break; }
    }
  }
  return results;
}

function computeStructuralMarkers(userText: string, profile: UserProfile): EvidenceEntry[] {
  const results: EvidenceEntry[] = [];
  for (const entry of getUserEntries().filter((e) => e.detection === "computed")) {
    switch (entry.marker) {
      case "message_shortening": { if (profile.baseline.avgMessageLength > 0 && userText.length < profile.baseline.avgMessageLength * 0.5) results.push(entry); break; }
      case "greeting_dropout": { if (profile.baseline.greetingPresent && profile.baseline.turnCount > 3 && !/\b(hi|hey|hello|good morning|good afternoon|hoi|hallo|goedemorgen|goedemiddag)\b/i.test(userText)) results.push(entry); break; }
    }
  }
  return results;
}

function computeBaselineDeviation(userText: string, profile: UserProfile): number {
  const bl = profile.baseline; let deviation = 0;
  if (bl.avgMessageLength > 0) { const ratio = userText.length / bl.avgMessageLength; if (ratio < 0.4) deviation += 0.2; if (ratio > 2.5) deviation += 0.1; }
  const sentences = userText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (bl.avgSentenceCount > 0 && sentences.length / bl.avgSentenceCount < 0.5) deviation += 0.1;
  if ((userText.match(/!/g) || []).length > 1) deviation += 0.15;
  if ((userText.match(/\?/g) || []).length > 2) deviation += 0.1;
  if ((userText.match(/\b[A-Z]{2,}\b/g) || []).length > 0) deviation += 0.15;
  return clamp01(deviation);
}

function updateBaseline(userText: string, profile: UserProfile, level: FrictionLevel) {
  if (level > 0) return;
  const bl = profile.baseline; const alpha = Math.min(0.1, 1 / (bl.turnCount + 1));
  bl.avgMessageLength = bl.avgMessageLength * (1 - alpha) + userText.length * alpha;
  bl.avgSentenceCount = bl.avgSentenceCount * (1 - alpha) + userText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length * alpha;
  if (bl.turnCount < 5) bl.greetingPresent = /\b(hi|hey|hello|good morning|hoi|hallo|goedemorgen)\b/i.test(userText);
  bl.turnCount++; bl.lastCalibrated = new Date().toISOString();
  profile.recentTurnLengths.push(userText.length);
  if (profile.recentTurnLengths.length > BASELINE_WINDOW) profile.recentTurnLengths.shift();
}

interface FrictionResult { level: FrictionLevel; matchedEntries: EvidenceEntry[]; baselineDeviation: number; signatureUpdates: Partial<Record<Signature, number>>; constraintsToActivate: Constraint[]; }

function assessFriction(userText: string, profile: UserProfile, lang: string): FrictionResult {
  const patternMatches = matchUserInput(userText, lang);
  const structuralMatches = computeStructuralMarkers(userText, profile);
  const baselineDeviation = computeBaselineDeviation(userText, profile);
  let maxLevel: FrictionLevel = 0; const allMatched: EvidenceEntry[] = [];
  for (const { entry } of patternMatches) { allMatched.push(entry); if (entry.level > maxLevel) maxLevel = entry.level as FrictionLevel; }
  for (const entry of structuralMatches) { allMatched.push(entry); if (entry.level > maxLevel) maxLevel = entry.level as FrictionLevel; }
  if (maxLevel === 0 && baselineDeviation > 0.35) maxLevel = 1;
  const grievanceMatches = matchGrievance(userText, lang as "nl" | "en");
  if (grievanceFrictionLevel(grievanceMatches) > maxLevel) maxLevel = grievanceFrictionLevel(grievanceMatches);
  const constraints = new Set<Constraint>();
  for (const entry of allMatched) { if (entry.severity + baselineDeviation * 0.3 > 0.3) for (const c of entry.suggestedConstraints) constraints.add(c); }
  for (const c of grievanceConstraints(grievanceMatches)) constraints.add(c);
  const sigUpdates: Partial<Record<Signature, number>> = {};
  const inc = SIGNATURE_INCREMENT[maxLevel] || 0;
  if (inc > 0) { for (const entry of allMatched) { switch (entry.marker) { case "explicit_correction": case "question_repetition": sigUpdates.repetition = inc; break; case "sarcasm_dismissal": case "exasperation_expression": sigUpdates.cliche_empathy = inc; break; case "imperative_command": case "hostile_label": case "profanity_directed": sigUpdates.helpdesk_tone = inc * 1.5; sigUpdates.over_explain = inc; break; case "disengagement_threat": case "termination_demand": sigUpdates.helpdesk_tone = inc * 2; break; } } }
  const grievanceSigUpdates = grievanceSignatureUpdates(grievanceMatches);
  for (const [sig, val] of Object.entries(grievanceSigUpdates)) sigUpdates[sig as Signature] = (sigUpdates[sig as Signature] || 0) + (val as number);
  return { level: maxLevel, matchedEntries: allMatched, baselineDeviation, signatureUpdates: sigUpdates, constraintsToActivate: [...constraints] };
}

function buildConstraintPrompt(profile: UserProfile): string {
  const active = profile.constraints.filter((c) => c.enabled);
  const activeBans = profile.bannedPhrases.filter((b) => new Date(b.expiresAt).getTime() > Date.now());
  const promoted = getPromotedBans(); const mined = getMinedPatterns();
  const existingPhrases = new Set(activeBans.map((b) => b.phrase));
  const allBanPhrases = [
    ...activeBans.map((b) => b.phrase),
    ...promoted.filter((p) => !existingPhrases.has(p)),
    ...mined.filter((p) => !existingPhrases.has(p) && !promoted.includes(p)),
    ...loadExpandedBanVariants().filter((p) => !existingPhrases.has(p)),
  ];
  if (active.length === 0 && allBanPhrases.length === 0) return "";
  const rules: string[] = []; const ids = new Set(active.map((c) => c.id));
  if (allBanPhrases.length > 0) rules.push(`HARD BAN — do NOT use any of these phrases or close variants: ${allBanPhrases.map((b) => `"${b}"`).join(", ")}. This is non-negotiable. Do not rephrase them, do not use synonyms that convey the same filler pattern.`);
  if (ids.has("BAN_CLICHE_PHRASES")) rules.push("Avoid all performative empathy. No cliché comfort phrases.");
  if (ids.has("NO_HELPDESK")) rules.push("Do not use helpdesk filler language. No \"would you like me to\", \"let me know\", \"great question\". Respond directly.");
  if (ids.has("NO_UNASKED_ADVICE_EMOTIONAL")) rules.push("When the user expresses emotion without asking for advice, do not give advice, steps, plans, or solutions.");
  if (ids.has("DEFAULT_PROSE")) rules.push("Write in prose paragraphs. No bullet points or numbered lists unless the user explicitly asks.");
  if (ids.has("MAX_LEN_600")) rules.push(`Keep your response under ${MAX_RESPONSE_LENGTH} characters.`);
  if (ids.has("NO_REPETITION")) rules.push("Do not repeat sentences, phrases, or ideas from previous messages.");
  if (ids.has("EXECUTE_NOW")) rules.push("ACTION AVOIDANCE DETECTED. You are acknowledging tasks without executing them. Do NOT explain what you should do. Do NOT confirm you understand. EXECUTE the action in this turn and report what you did. If the action requires a tool call, file write, or command: do it NOW, not next turn.");
  return "\n\n[INTERACTION CONSTRAINTS — learned from this user's preferences]\n" + rules.map((r, i) => `${i + 1}. ${r}`).join("\n") + "\n[END CONSTRAINTS]\n";
}

function buildFrictionNote(level: FrictionLevel): string {
  if (level === 0) return "";
  if (level === 1) return "\n[NOTE: Subtle signs of friction detected. Be precise, brief, avoid filler.]\n";
  if (level === 2) return "\n[NOTE: User is clearly irritated. Respond minimally, directly, no pleasantries.]\n";
  return "\n[NOTE: User is strongly frustrated. One or two sentences maximum. No advice, no structure, no apology.]\n";
}

function stripChannelMetadata(text: string): string {
  text = text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, "");
  let cleaned = text.replace(/(?:Conversation info|Sender|Message context|Channel metadata)\s*\(untrusted metadata\)\s*:\s*```json?\s*\{[\s\S]*?\}\s*```/gi, "");
  cleaned = cleaned.replace(/(?:Conversation info|Sender|Message context|Channel metadata)\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}/gi, "");
  cleaned = cleaned.replace(/```json?\s*\{\s*"(?:message_id|sender_id|sender|label|id|name|e164)[\s\S]*?\}\s*```/gi, "");
  cleaned = cleaned.replace(/^(?:queued|cron|heartbeat|system):.*$/gm, "");
  cleaned = cleaned.replace(/\[(?:media attached|audio message|video message|image|sticker|document|voice note|gif)[^\]]*\]/gi, "");
  cleaned = cleaned.replace(/^(?:To (?:send|reply|respond|return|attach|include|upload)[\s\S]*?)(?=\n\n|\n[A-Z]|$)/gim, "");
  cleaned = cleaned.replace(/^(?:Note:|Instructions?:|System:|Context:).*$/gm, "");
  cleaned = cleaned.replace(/^.*(?:send (?:the |an? )?image|return (?:the |an? )?(?:image|file|media)|attach (?:the |an? )?(?:image|file)).*$/gim, "");
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

function extractLastAgentMessage(messages: any[]): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) { const msg = messages[i]; if (msg.role === "assistant") { if (typeof msg.content === "string" && msg.content.length > 0) return msg.content.slice(0, 500); if (Array.isArray(msg.content)) { const part = msg.content.find((p: any) => p.type === "text" && typeof p.text === "string"); if (part) return part.text.slice(0, 500); } } }
  return null;
}

function extractLastUserMessage(messages: any[]): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) { const msg = messages[i]; if (msg.role === "user") { let text: string | null = null; if (typeof msg.content === "string") text = msg.content; if (Array.isArray(msg.content)) { const part = msg.content.find((p: any) => p.type === "text" && typeof p.text === "string"); if (part) text = part.text; } if (text) { const cleaned = stripChannelMetadata(text); if (cleaned.length > 0) return cleaned; } } }
  return null;
}

function extractUserId(ctx: any): string { return ctx?.context?.senderId || ctx?.context?.sessionEntry?.peer || ctx?.sessionKey?.split(":")?.pop() || "default"; }
function cleanExpiredBans(profile: UserProfile) { profile.bannedPhrases = profile.bannedPhrases.filter((b) => new Date(b.expiresAt).getTime() > Date.now()); }

function addBan(profile: UserProfile, phrase: string, severity: number, sourceId: string) {
  if (profile.bannedPhrases.some((b) => b.phrase === phrase)) return;
  profile.bannedPhrases.push({ phrase, severity, source: sourceId, expiresAt: new Date(Date.now() + BAN_TTL_MS * (0.5 + severity)).toISOString() });
}

export default {
  id: "friction-guard", name: "Friction Guard",
  configSchema: { type: "object", properties: { enabled: { type: "boolean", default: true }, defaultLanguage: { type: "string", default: "en", enum: ["en", "nl"] }, maxResponseLength: { type: "number", default: 600 }, constraintDecayHours: { type: "number", default: 48 }, banTtlHours: { type: "number", default: 2 }, backgroundIntervalMinutes: { type: "number", default: 15 } } },

  register(api: any) {
    const logger = api.logger ?? console;
    const config: FrictionGuardConfig = api.config ?? {};
    if (config.maxResponseLength) MAX_RESPONSE_LENGTH = config.maxResponseLength;
    if (config.constraintDecayHours) setConstraintDecayHours(config.constraintDecayHours);
    if (config.banTtlHours) BAN_TTL_MS = config.banTtlHours * 60 * 60 * 1000;
    if (config.backgroundIntervalMinutes) BACKGROUND_INTERVAL_MS = config.backgroundIntervalMinutes * 60 * 1000;
    configurePaths(config);
    const defaultLang = config.defaultLanguage || "en";
    logger.info("[friction-guard] v4.0.0 — pre-generation constraint injection");
    try { const entries = loadEvidence(); logger.info(`[friction-guard] Evidence registry: ${entries.length} entries loaded`); loadGrievanceDictionary(); loadAgentIrritationRegistry(); loadPrimingExamples(); } catch (e) { logger.warn("[friction-guard] Could not load evidence registry:", e); logErrorToFile("tool_fail", "[friction-guard] evidence registry load failed: " + String(e)); }

    api.on("before_prompt_build", (event: any, ctx: any) => {
        try {
          const messages = event?.messages ?? ctx?.messages ?? [];
          const userText = extractLastUserMessage(messages);
          if (!userText) return {};
          const userId = extractUserId(ctx);
          const profile = readProfile(userId);
          const lang = detectLanguage(userText, defaultLang);
          cleanExpiredBans(profile);
          const agentText = extractLastAgentMessage(messages);
          if (agentText) recordTurn(userId, "agent", agentText);
          recordTurn(userId, "user", userText);
          const assessment = assessFriction(userText, profile, lang);
          if (assessment.level < 2) { const repetition = detectUserForcedRepetition(userText, userId); if (repetition.detected) { profile.signatures.repetition = clamp01(profile.signatures.repetition + 0.10); logFragment(userId, "user", userText.slice(0, 300), 2 as FrictionLevel, ["USER-FORCED-REPEAT"], 0, ["NO_REPETITION"], { repetition: 0.10 }); } }
          if (detectActionAvoidanceLoop(userId, lang)) { const execConstraint = profile.constraints.find((c) => c.id === "EXECUTE_NOW"); if (execConstraint) { execConstraint.enabled = true; execConstraint.lastTriggered = new Date().toISOString(); } else { profile.constraints.push({ id: "EXECUTE_NOW", enabled: true, confidence: 0.9, lastTriggered: new Date().toISOString() }); } logFragment(userId, "agent", "[action-avoidance-loop]", 2 as FrictionLevel, ["ACTION-AVOIDANCE"], 0, ["EXECUTE_NOW"], { helpdesk: 0.15 }); }
          for (const [sig, inc] of Object.entries(assessment.signatureUpdates)) profile.signatures[sig as Signature] = clamp01(profile.signatures[sig as Signature] + (inc as number));
          for (const constraint of assessment.constraintsToActivate) { const existing = profile.constraints.find((c) => c.id === constraint); if (existing) { existing.enabled = true; existing.lastTriggered = new Date().toISOString(); } else { profile.constraints.push({ id: constraint, enabled: true, confidence: 0.65, lastTriggered: new Date().toISOString() }); } }
          if (assessment.level > 0) logFragment(userId, "user", userText.slice(0, 300), assessment.level, assessment.matchedEntries.map((e) => e.id), assessment.baselineDeviation, assessment.constraintsToActivate, assessment.signatureUpdates);
          for (const entry of assessment.matchedEntries) { if (entry.level >= 2 && entry.patterns) { const phrases = entry.patterns[lang] || entry.patterns["en"] || []; for (const phrase of phrases) { if (userText.toLowerCase().includes(phrase)) { for (const ap of getAgentEntries()) { if (ap.suggestedConstraints.some((c) => entry.suggestedConstraints.includes(c))) { for (const agentPhrase of (ap.patterns?.[lang] || ap.patterns?.["en"] || [])) addBan(profile, agentPhrase, entry.severity, entry.id); } } break; } } } }
          profile.currentFrictionLevel = assessment.level;
          updateBaseline(userText, profile, assessment.level);
          inferConstraints(profile); writeProfile(profile);
          const injection = buildColdStartPrompt(profile.baseline.turnCount) + buildConstraintPrompt(profile) + buildFrictionNote(assessment.level);
          if (Date.now() - _lastBackgroundRun > BACKGROUND_INTERVAL_MS) { _lastBackgroundRun = Date.now(); try { runBackgroundAnalysis(userId); } catch (e) { logger.warn("[friction-guard] Background analysis error:", e); logErrorToFile("tool_fail", "[friction-guard] background analysis failed: " + String(e)); } try { const mineResult = runPatternMining(); if (mineResult.promoted.length > 0) logger.info(`[friction-guard] Pattern miner: ${mineResult.promoted.length} new patterns promoted`); } catch (e) { logger.warn("[friction-guard] Pattern miner error:", e); } triggerSemanticRefresh(logger); }
          if (Date.now() - _lastClassifierRun > CLASSIFIER_INTERVAL_MS) { _lastClassifierRun = Date.now(); if (typeof api.complete === "function") { runClassification(async (prompt: string) => { const result = await api.complete({ messages: [{ role: "user", content: prompt }], maxTokens: 2000 }); return typeof result === "string" ? result : result?.content || ""; }).then((r) => { if (r.newCandidates > 0 || r.promoted.length > 0) logger.info(`[friction-guard] Classifier: ${r.newCandidates} new candidates, ${r.promoted.length} promoted to ban`); }).catch((e) => logger.warn("[friction-guard] Classifier error:", e)); } }
          return injection.trim() ? { prependSystemContext: injection } : {};
        } catch (e) { logger.error("[friction-guard] Error:", e); logErrorToFile("tool_fail", "[friction-guard] pre-generation error: " + String(e)); return {}; }
      }, { priority: 50 });
    logger.info("[friction-guard] Registered on before_prompt_build");
  },
};
