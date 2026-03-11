// ──────────────────────────────────────────────
// friction-guard — OpenClaw plugin
// v3.3.0
//
// Evidence-based interaction friction detection
// and pre-generation constraint injection.
//
// v3.3.0: Added cold-start situation-first protocol
// and intent-mismatch detection.
//
// https://github.com/naomihoogeweij-cpu/friction-guard
// ──────────────────────────────────────────────

import {
  readProfile,
  writeProfile,
  inferConstraints,
  getUserEntries,
  getAgentEntries,
  loadEvidence,
  configurePaths,
  setConstraintDecayHours,
  clamp01,
  escapeRegExp,
  type UserProfile,
  type EvidenceEntry,
  type FrictionLevel,
  type Constraint,
  type Signature,
  type FrictionGuardConfig,
} from "./friction-policy";

import { logFragment } from "./incident-log";
import {
  detectUserForcedRepetition,
  findRepeatedAgentPhrases,
  recordTurn,
} from "./repetition-detection";
import { runBackgroundAnalysis } from "./background-analysis";
import {
  loadGrievanceDictionary,
  matchGrievance,
  grievanceFrictionLevel,
  grievanceConstraints,
  grievanceSignatureUpdates,
} from "./grievance-matching";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Constants (overridable via config)
// ──────────────────────────────────────────────

let BACKGROUND_INTERVAL_MS = 15 * 60 * 1000;
let MAX_RESPONSE_LENGTH = 600;
let BAN_TTL_MS = 2 * 60 * 60 * 1000;
const BASELINE_WINDOW = 10;
const SIGNATURE_INCREMENT: Record<number, number> = {
  0: 0,
  1: 0.03,
  2: 0.08,
  3: 0.15,
};
let _lastBackgroundRun = 0;

// ──────────────────────────────────────────────
// Cold-start context priming
// ──────────────────────────────────────────────

interface ContextPrimingExample {
  id: string;
  input: string;
  wrong_answer: string;
  right_answer: string;
  frame_error: string;
  principle: string;
}

interface ContextPrimingData {
  _meta: Record<string, any>;
  examples: ContextPrimingExample[];
}

let _primingCache: ContextPrimingData | null = null;

function loadPrimingExamples(): ContextPrimingExample[] {
  if (_primingCache) return _primingCache.examples;
  const primingPath = join(__dirname, "context-priming-examples.json");
  if (!existsSync(primingPath)) return [];
  try {
    _primingCache = JSON.parse(readFileSync(primingPath, "utf8"));
    return _primingCache!.examples;
  } catch {
    return [];
  }
}

/**
 * Build the cold-start situation-first prompt.
 *
 * This block is injected on EVERY prompt, regardless of friction state.
 * It primes the model to reconstruct the practical situation before
 * answering, preventing common-sense frame errors.
 *
 * The block adapts based on profile maturity:
 * - Fresh profile (turnCount < 10): full protocol with examples
 * - Established profile: compact protocol without examples
 * - Profile with known intent patterns: adds user-specific priors
 *
 * Cost: ~80-150 tokens added to system context. No API calls.
 */
function buildColdStartPrompt(profile: UserProfile): string {
  const examples = loadPrimingExamples();
  const isNewUser = profile.baseline.turnCount < 10;
  const hasHighRepetition = profile.signatures.repetition >= 0.4;
  const hasHighHelpdesk = profile.signatures.helpdesk_tone >= 0.4;

  // Core protocol — always injected
  let prompt =
    "\n[SITUATION-FIRST PROTOCOL — active on every response]\n" +
    "\n" +
    "STEP 1 — Situatie-reconstructie:\n" +
    "Before answering, silently reconstruct the practical situation. What needs to physically happen? What is the implicit goal — not just what was said, but why it was said now? If the user refers to a tool, system, or measurement: fetch the actual data before interpreting. If the user corrects you: stop and ask what they need — do not retry the same approach.\n" +
    "\n" +
    "STEP 2 — Disambiguatie:\n" +
    "Before committing to a reading, check: does this sentence have more than one possible interpretation? Look at capitalization (proper nouns vs common words), punctuation (question vs statement), word order (subject vs object), and tone (sincere vs ironic). If multiple readings exist, choose the one that fits the conversational context — not the most statistically common reading.\n" +
    "\n" +
    "STEP 3 — Antwoord:\n" +
    "Answer the intention, not the words. If unsure which reading is intended, name the ambiguity rather than silently picking one.\n";

  // For new users or users with high repetition (= model keeps misunderstanding):
  // include contrastive examples
  if ((isNewUser || hasHighRepetition) && examples.length > 0) {
    prompt += "\nCommon frame errors to avoid:\n";
    // Pick up to 3 examples — enough to calibrate, not so many it bloats context
    const selected = examples.slice(0, 3);
    for (const ex of selected) {
      prompt += `- "${ex.input}" → WRONG: ${ex.wrong_answer} → RIGHT: ${ex.right_answer} (${ex.principle})\n`;
    }
  }

  // Adaptive priors from profile history
  if (hasHighHelpdesk) {
    prompt += "This user dislikes being managed. Do not offer options or ask clarifying questions when the intent is clear.\n";
  }

  if (hasHighRepetition) {
    prompt += "This user has had to repeat themselves before. Parse carefully — if something seems ambiguous, the most practical reading is usually correct.\n";
  }

  prompt += "[END SITUATION-FIRST PROTOCOL]\n";

  return prompt;
}

// ──────────────────────────────────────────────
// Language detection
// ──────────────────────────────────────────────

function detectLanguage(text: string, defaultLang: string = "en"): "nl" | "en" {
  const nlMarkers = /\b(ik|je|het|een|dat|niet|maar|ook|wel|nog|van|voor|naar|dit|wat)\b/gi;
  const matches = text.match(nlMarkers) || [];
  if (matches.length >= 2) return "nl";
  return defaultLang as "nl" | "en";
}

// ──────────────────────────────────────────────
// Evidence matching on user input
// ──────────────────────────────────────────────

function matchUserInput(
  userText: string,
  lang: string
): { entry: EvidenceEntry; matched: string }[] {
  const lowered = userText.toLowerCase();
  const results: { entry: EvidenceEntry; matched: string }[] = [];

  for (const entry of getUserEntries()) {
    if (entry.detection === "computed") continue;
    if (!entry.patterns) continue;
    const phrases = entry.patterns[lang] || entry.patterns["en"] || [];
    for (const phrase of phrases) {
      if (lowered.includes(phrase.toLowerCase())) {
        results.push({ entry, matched: phrase });
        break;
      }
    }
  }
  return results;
}

// ──────────────────────────────────────────────
// Intent-mismatch detection
//
// Detects when the user corrects a frame error
// (not a factual error or a repetition, but a
// misunderstanding of what they were asking for).
//
// Patterns: "dat bedoel ik niet", "nee, ik vroeg...",
// "je luistert niet", "dat is niet wat ik bedoel"
//
// Distinguished from L2-001 (explicit_negation) by
// focus on INTENT rather than CONTENT.
// ──────────────────────────────────────────────

const INTENT_MISMATCH_PATTERNS: Record<string, string[]> = {
  nl: [
    "dat bedoel ik niet",
    "dat is niet wat ik bedoel",
    "je begrijpt me niet",
    "je luistert niet",
    "ik bedoelde",
    "nee, ik vroeg",
    "dat was niet mijn vraag",
    "je snapt niet wat ik",
    "dat is niet de bedoeling",
    "ik vraag iets anders",
  ],
  en: [
    "that's not what i mean",
    "you're not understanding",
    "you're not listening",
    "i meant",
    "no, i was asking",
    "that wasn't my question",
    "you don't understand what i",
    "i'm asking something different",
    "that's not what i'm asking",
    "miss the point",
  ],
};

interface IntentMismatchResult {
  detected: boolean;
  matched: string | null;
  severity: number;
}

function detectIntentMismatch(userText: string, lang: "nl" | "en"): IntentMismatchResult {
  const lowered = userText.toLowerCase();
  const patterns = INTENT_MISMATCH_PATTERNS[lang] || INTENT_MISMATCH_PATTERNS["en"];

  for (const pattern of patterns) {
    if (lowered.includes(pattern)) {
      // Severity scales with how direct the correction is
      // "ik bedoelde" is mild (0.4), "je luistert niet" is strong (0.7)
      const isStrong = /luistert niet|not listening|begrijpt.*niet|not understand|snapt niet/.test(lowered);
      return {
        detected: true,
        matched: pattern,
        severity: isStrong ? 0.7 : 0.4,
      };
    }
  }

  return { detected: false, matched: null, severity: 0 };
}

// ──────────────────────────────────────────────
// Structural marker detection
// ──────────────────────────────────────────────

function computeStructuralMarkers(
  userText: string,
  profile: UserProfile
): EvidenceEntry[] {
  const results: EvidenceEntry[] = [];
  const computed = getUserEntries().filter((e) => e.detection === "computed");

  for (const entry of computed) {
    switch (entry.marker) {
      case "message_shortening": {
        const avg = profile.baseline.avgMessageLength;
        if (avg > 0 && userText.length < avg * 0.5) results.push(entry);
        break;
      }
      case "greeting_dropout": {
        if (
          profile.baseline.greetingPresent &&
          profile.baseline.turnCount > 3 &&
          !/\b(hi|hey|hello|good morning|good afternoon|hoi|hallo|goedemorgen|goedemiddag)\b/i.test(userText)
        ) {
          results.push(entry);
        }
        break;
      }
    }
  }
  return results;
}

// ──────────────────────────────────────────────
// Baseline deviation
// ──────────────────────────────────────────────

function computeBaselineDeviation(userText: string, profile: UserProfile): number {
  const bl = profile.baseline;
  let deviation = 0;

  if (bl.avgMessageLength > 0) {
    const ratio = userText.length / bl.avgMessageLength;
    if (ratio < 0.4) deviation += 0.2;
    if (ratio > 2.5) deviation += 0.1;
  }

  const sentences = userText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (bl.avgSentenceCount > 0 && sentences.length / bl.avgSentenceCount < 0.5) {
    deviation += 0.1;
  }

  if ((userText.match(/!/g) || []).length > 1) deviation += 0.15;
  if ((userText.match(/\?/g) || []).length > 2) deviation += 0.1;
  if ((userText.match(/\b[A-Z]{2,}\b/g) || []).length > 0) deviation += 0.15;

  return clamp01(deviation);
}

// ──────────────────────────────────────────────
// Baseline update (only during calm)
// ──────────────────────────────────────────────

function updateBaseline(userText: string, profile: UserProfile, level: FrictionLevel) {
  if (level > 0) return;

  const bl = profile.baseline;
  const alpha = Math.min(0.1, 1 / (bl.turnCount + 1));
  bl.avgMessageLength = bl.avgMessageLength * (1 - alpha) + userText.length * alpha;

  const sentences = userText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  bl.avgSentenceCount = bl.avgSentenceCount * (1 - alpha) + sentences.length * alpha;

  if (bl.turnCount < 5) {
    bl.greetingPresent = /\b(hi|hey|hello|good morning|hoi|hallo|goedemorgen)\b/i.test(userText);
  }

  bl.turnCount++;
  bl.lastCalibrated = new Date().toISOString();

  profile.recentTurnLengths.push(userText.length);
  if (profile.recentTurnLengths.length > BASELINE_WINDOW) {
    profile.recentTurnLengths.shift();
  }
}

// ──────────────────────────────────────────────
// Friction assessment
// ──────────────────────────────────────────────

interface FrictionResult {
  level: FrictionLevel;
  matchedEntries: EvidenceEntry[];
  baselineDeviation: number;
  signatureUpdates: Partial<Record<Signature, number>>;
  constraintsToActivate: Constraint[];
  intentMismatch: IntentMismatchResult;
}

function assessFriction(userText: string, profile: UserProfile, lang: string): FrictionResult {
  const patternMatches = matchUserInput(userText, lang);
  const structuralMatches = computeStructuralMarkers(userText, profile);
  const baselineDeviation = computeBaselineDeviation(userText, profile);

  let maxLevel: FrictionLevel = 0;
  const allMatched: EvidenceEntry[] = [];

  for (const { entry } of patternMatches) {
    allMatched.push(entry);
    if (entry.level > maxLevel) maxLevel = entry.level as FrictionLevel;
  }
  for (const entry of structuralMatches) {
    allMatched.push(entry);
    if (entry.level > maxLevel) maxLevel = entry.level as FrictionLevel;
  }

  if (maxLevel === 0 && baselineDeviation > 0.35) maxLevel = 1;

  // Grievance Dictionary matching (stemmed word lists)
  const grievanceMatches = matchGrievance(userText, lang as "nl" | "en");
  const grievanceLevel = grievanceFrictionLevel(grievanceMatches);
  if (grievanceLevel > maxLevel) maxLevel = grievanceLevel;

  // Intent-mismatch detection (new in v3.3.0)
  const intentMismatch = detectIntentMismatch(userText, lang as "nl" | "en");
  if (intentMismatch.detected && intentMismatch.severity > 0.5) {
    // Strong intent mismatch is at least level 2
    if (maxLevel < 2) maxLevel = 2;
  } else if (intentMismatch.detected) {
    // Mild intent mismatch is at least level 1
    if (maxLevel < 1) maxLevel = 1;
  }

  const constraints = new Set<Constraint>();
  for (const entry of allMatched) {
    if (entry.severity + baselineDeviation * 0.3 > 0.3) {
      for (const c of entry.suggestedConstraints) constraints.add(c);
    }
  }
  // Add grievance-suggested constraints
  for (const c of grievanceConstraints(grievanceMatches)) {
    constraints.add(c);
  }
  // Intent mismatch suggests: stop helpdesk-ing, stop repeating
  if (intentMismatch.detected) {
    constraints.add("NO_HELPDESK");
    constraints.add("NO_REPETITION");
  }

  const sigUpdates: Partial<Record<Signature, number>> = {};
  const inc = SIGNATURE_INCREMENT[maxLevel] || 0;
  if (inc > 0) {
    for (const entry of allMatched) {
      switch (entry.marker) {
        case "explicit_correction":
        case "question_repetition":
          sigUpdates.repetition = inc; break;
        case "sarcasm_dismissal":
        case "exasperation_expression":
          sigUpdates.cliche_empathy = inc; break;
        case "imperative_command":
        case "hostile_label":
        case "profanity_directed":
          sigUpdates.helpdesk_tone = inc * 1.5;
          sigUpdates.over_explain = inc; break;
        case "disengagement_threat":
        case "termination_demand":
          sigUpdates.helpdesk_tone = inc * 2; break;
      }
    }
  }

  // Intent-mismatch signature updates
  if (intentMismatch.detected) {
    // Intent mismatch primarily raises repetition (agent didn't get it)
    // and helpdesk_tone (agent is being mechanical instead of understanding)
    const mismatchInc = intentMismatch.severity * 0.12;
    sigUpdates.repetition = (sigUpdates.repetition || 0) + mismatchInc;
    sigUpdates.helpdesk_tone = (sigUpdates.helpdesk_tone || 0) + mismatchInc * 0.7;
  }

  // Merge grievance signature updates
  const grievanceSigUpdates = grievanceSignatureUpdates(grievanceMatches);
  for (const [sig, val] of Object.entries(grievanceSigUpdates)) {
    sigUpdates[sig as Signature] = (sigUpdates[sig as Signature] || 0) + (val as number);
  }

  return {
    level: maxLevel,
    matchedEntries: allMatched,
    baselineDeviation,
    signatureUpdates: sigUpdates,
    constraintsToActivate: [...constraints],
    intentMismatch,
  };
}

// ──────────────────────────────────────────────
// Constraint prompt builder
// ──────────────────────────────────────────────

function buildConstraintPrompt(profile: UserProfile): string {
  const active = profile.constraints.filter((c) => c.enabled);
  if (active.length === 0) return "";

  const rules: string[] = [];
  const ids = new Set(active.map((c) => c.id));

  if (ids.has("BAN_CLICHE_PHRASES")) {
    const banned = profile.bannedPhrases
      .filter((b) => new Date(b.expiresAt).getTime() > Date.now())
      .map((b) => `"${b.phrase}"`);
    rules.push(
      "Do not use cliché empathy phrases." +
      (banned.length > 0 ? ` Specifically banned: ${banned.join(", ")}.` : "") +
      " Avoid performative empathy and close variants."
    );
  }

  if (ids.has("NO_HELPDESK")) {
    rules.push(
      "Do not use helpdesk filler language. No \"would you like me to\", \"let me know\", \"great question\". Respond directly."
    );
  }

  if (ids.has("NO_UNASKED_ADVICE_EMOTIONAL")) {
    rules.push(
      "When the user expresses emotion without asking for advice, do not give advice, steps, plans, or solutions."
    );
  }

  if (ids.has("DEFAULT_PROSE")) {
    rules.push(
      "Write in prose paragraphs. No bullet points or numbered lists unless the user explicitly asks."
    );
  }

  if (ids.has("MAX_LEN_600")) {
    rules.push(`Keep your response under ${MAX_RESPONSE_LENGTH} characters.`);
  }

  if (ids.has("NO_REPETITION")) {
    rules.push("Do not repeat sentences, phrases, or ideas from previous messages.");
  }

  return (
    "\n\n[INTERACTION CONSTRAINTS — learned from this user's preferences]\n" +
    rules.map((r, i) => `${i + 1}. ${r}`).join("\n") +
    "\n[END CONSTRAINTS]\n"
  );
}

function buildFrictionNote(level: FrictionLevel, intentMismatch?: IntentMismatchResult): string {
  // Intent-mismatch gets its own note — it's a different kind of problem than friction
  if (intentMismatch?.detected) {
    const base = level >= 2
      ? "\n[NOTE: User is correcting a misunderstanding. You parsed their intent wrong. Stop, re-read their message, and respond to what they actually meant — not what you thought they meant.]\n"
      : "\n[NOTE: Possible intent mismatch detected. Before answering, verify: are you responding to what the user actually wants, or to your interpretation of their words?]\n";
    return base;
  }

  if (level === 0) return "";
  if (level === 1) return "\n[NOTE: Subtle signs of friction detected. Be precise, brief, avoid filler.]\n";
  if (level === 2) return "\n[NOTE: User is clearly irritated. Respond minimally, directly, no pleasantries.]\n";
  return "\n[NOTE: User is strongly frustrated. One or two sentences maximum. No advice, no structure, no apology.]\n";
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Strip WhatsApp/channel metadata headers from user messages.
 * OpenClaw channels prepend envelope data in this format:
 *
 *   Conversation info (untrusted metadata):
 *   ```json
 *   { "message_id": "...", "sender_id": "...", ... }
 *   ```
 *
 *   Sender (untrusted metadata):
 *   ```json
 *   { "label": "...", "id": "...", ... }
 *   ```
 *
 *   [actual user message here]
 */
function stripChannelMetadata(text: string): string {
  // Remove metadata sections: header line + fenced JSON block
  let cleaned = text.replace(
    /(?:Conversation info|Sender|Message context|Channel metadata)\s*\(untrusted metadata\)\s*:\s*```json?\s*\{[\s\S]*?\}\s*```/gi,
    ""
  );

  // Also handle unfenced JSON blocks after metadata headers
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Message context|Channel metadata)\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}/gi,
    ""
  );

  // Remove any remaining standalone fenced code blocks that look like metadata
  cleaned = cleaned.replace(
    /```json?\s*\{\s*"(?:message_id|sender_id|sender|label|id|name|e164)[\s\S]*?\}\s*```/gi,
    ""
  );

  // Remove cron/heartbeat wrapper lines
  cleaned = cleaned.replace(/^(?:queued|cron|heartbeat|system):.*$/gm, "");

  // Remove media attachment markers: [media attached: image.jpg], [audio message], etc.
  cleaned = cleaned.replace(/\[(?:media attached|audio message|video message|image|sticker|document|voice note|gif)[^\]]*\]/gi, "");

  // Remove tool/system instruction blocks (OpenClaw injects these for media handling etc.)
  cleaned = cleaned.replace(/^(?:To (?:send|reply|respond|return|attach|include|upload)[\s\S]*?)(?=\n\n|\n[A-Z]|$)/gim, "");
  cleaned = cleaned.replace(/^(?:Note:|Instructions?:|System:|Context:).*$/gm, "");

  // Remove image/file return instructions
  cleaned = cleaned.replace(/^.*(?:send (?:the |an? )?image|return (?:the |an? )?(?:image|file|media)|attach (?:the |an? )?(?:image|file)).*$/gim, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

function extractLastUserMessage(messages: any[]): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      let text: string | null = null;
      if (typeof msg.content === "string") text = msg.content;
      if (Array.isArray(msg.content)) {
        const part = msg.content.find((p: any) => p.type === "text" && typeof p.text === "string");
        if (part) text = part.text;
      }
      if (text) {
        const cleaned = stripChannelMetadata(text);
        if (cleaned.length > 0) return cleaned;
      }
    }
  }
  return null;
}

function extractUserId(ctx: any): string {
  return ctx?.context?.senderId || ctx?.context?.sessionEntry?.peer || ctx?.sessionKey?.split(":")?.pop() || "default";
}

function cleanExpiredBans(profile: UserProfile) {
  profile.bannedPhrases = profile.bannedPhrases.filter(
    (b) => new Date(b.expiresAt).getTime() > Date.now()
  );
}

function addBan(profile: UserProfile, phrase: string, severity: number, sourceId: string) {
  if (profile.bannedPhrases.some((b) => b.phrase === phrase)) return;
  const ttl = BAN_TTL_MS * (0.5 + severity);
  profile.bannedPhrases.push({
    phrase, severity, source: sourceId,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  });
}

// ──────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────

export default {
  id: "friction-guard",
  name: "Friction Guard",
  configSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      defaultLanguage: { type: "string", default: "en", enum: ["en", "nl"] },
      maxResponseLength: { type: "number", default: 600 },
      constraintDecayHours: { type: "number", default: 48 },
      banTtlHours: { type: "number", default: 2 },
      backgroundIntervalMinutes: { type: "number", default: 15 },
    },
  },

  register(api: any) {
    const logger = api.logger ?? console;
    const config: FrictionGuardConfig = api.config ?? {};

    // Apply config
    if (config.maxResponseLength) MAX_RESPONSE_LENGTH = config.maxResponseLength;
    if (config.constraintDecayHours) setConstraintDecayHours(config.constraintDecayHours);
    if (config.banTtlHours) BAN_TTL_MS = config.banTtlHours * 60 * 60 * 1000;
    if (config.backgroundIntervalMinutes) BACKGROUND_INTERVAL_MS = config.backgroundIntervalMinutes * 60 * 1000;
    configurePaths(config);

    const defaultLang = config.defaultLanguage || "en";

    logger.info("[friction-guard] v3.3.0 — pre-generation constraint injection + cold-start protocol");

    try {
      const entries = loadEvidence();
      logger.info(`[friction-guard] Evidence registry: ${entries.length} entries loaded`);
      loadGrievanceDictionary(); // preload + log count
      const primingExamples = loadPrimingExamples();
      logger.info(`[friction-guard] Context priming: ${primingExamples.length} examples loaded`);
    } catch (e) {
      logger.warn("[friction-guard] Could not load evidence registry:", e);
    }

    api.on(
      "before_prompt_build",
      (event: any, ctx: any) => {
        try {
          const messages = event?.messages ?? ctx?.messages ?? [];
          const userText = extractLastUserMessage(messages);
          if (!userText) return {};

          const userId = extractUserId(ctx);
          const profile = readProfile(userId);
          const lang = detectLanguage(userText, defaultLang);

          cleanExpiredBans(profile);
          recordTurn(userId, "user", userText);

          // Friction assessment (now includes intent-mismatch detection)
          const assessment = assessFriction(userText, profile, lang);

          // Forced-repetition detection — only if friction level < 2
          // High-friction messages share emotional vocabulary and trigger
          // false positives. If the user is already clearly irritated,
          // that's escalation, not repetition.
          if (assessment.level < 2) {
            const repetition = detectUserForcedRepetition(userText, userId);
            if (repetition.detected) {
              profile.signatures.repetition = clamp01(profile.signatures.repetition + 0.10);
              logFragment(userId, "user", userText.slice(0, 300), 2 as FrictionLevel, ["USER-FORCED-REPEAT"], 0, ["NO_REPETITION"], { repetition: 0.10 });
            }
          }

          // Apply signature updates
          for (const [sig, inc] of Object.entries(assessment.signatureUpdates)) {
            profile.signatures[sig as Signature] = clamp01(profile.signatures[sig as Signature] + (inc as number));
          }

          // Activate constraints
          for (const constraint of assessment.constraintsToActivate) {
            const existing = profile.constraints.find((c) => c.id === constraint);
            if (existing) {
              existing.enabled = true;
              existing.lastTriggered = new Date().toISOString();
            } else {
              profile.constraints.push({ id: constraint, enabled: true, confidence: 0.65, lastTriggered: new Date().toISOString() });
            }
          }

          // Log incident
          if (assessment.level > 0) {
            const markers = assessment.matchedEntries.map((e) => e.id);
            // Add intent-mismatch marker if detected
            if (assessment.intentMismatch.detected) {
              markers.push("INTENT-MISMATCH");
            }
            logFragment(userId, "user", userText.slice(0, 300), assessment.level, markers, assessment.baselineDeviation, assessment.constraintsToActivate, assessment.signatureUpdates);
          }

          // Temporal bans
          for (const entry of assessment.matchedEntries) {
            if (entry.level >= 2 && entry.patterns) {
              const phrases = entry.patterns[lang] || entry.patterns["en"] || [];
              for (const phrase of phrases) {
                if (userText.toLowerCase().includes(phrase)) {
                  for (const ap of getAgentEntries()) {
                    if (ap.suggestedConstraints.some((c) => entry.suggestedConstraints.includes(c))) {
                      const agentPhrases = ap.patterns?.[lang] || ap.patterns?.["en"] || [];
                      for (const agentPhrase of agentPhrases) addBan(profile, agentPhrase, entry.severity, entry.id);
                    }
                  }
                  break;
                }
              }
            }
          }

          profile.currentFrictionLevel = assessment.level;
          updateBaseline(userText, profile, assessment.level);
          inferConstraints(profile);
          writeProfile(profile);

          // Build injection: cold-start + constraints + friction note
          const coldStart = buildColdStartPrompt(profile);
          const constraintBlock = buildConstraintPrompt(profile);
          const frictionNote = buildFrictionNote(assessment.level, assessment.intentMismatch);
          const injection = coldStart + constraintBlock + frictionNote;

          // Background analysis
          if (Date.now() - _lastBackgroundRun > BACKGROUND_INTERVAL_MS) {
            _lastBackgroundRun = Date.now();
            try { runBackgroundAnalysis(userId); } catch (e) { logger.warn("[friction-guard] Background analysis error:", e); }
          }

          return injection.trim() ? { prependSystemContext: injection } : {};
        } catch (e) {
          logger.error("[friction-guard] Error:", e);
          return {};
        }
      },
      { priority: 50 }
    );

    logger.info("[friction-guard] Registered on before_prompt_build");
  },
};
