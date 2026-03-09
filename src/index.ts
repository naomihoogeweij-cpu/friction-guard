// ──────────────────────────────────────────────
// friction-guard — OpenClaw plugin
// v3.0.0
//
// Evidence-based interaction friction detection
// and pre-generation constraint injection.
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

function buildFrictionNote(level: FrictionLevel): string {
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
 * OpenClaw channels prepend envelope data like:
 *   Conversation info (untrusted metadata): {...}
 *   Sender (untrusted metadata): {...}
 * before the actual user text.
 */
function stripChannelMetadata(text: string): string {
  // Remove lines starting with known metadata prefixes + their JSON blocks
  let cleaned = text
    .replace(/^Conversation info \(untrusted metadata\):.*$/gm, "")
    .replace(/^Sender \(untrusted metadata\):.*$/gm, "")
    .replace(/^\{[\s\S]*?\}$/gm, "") // remove standalone JSON blocks
    .replace(/^message_id:.*$/gm, "")
    .replace(/^timestamp:.*$/gm, "")
    .replace(/^\s*\n/gm, ""); // collapse empty lines

  return cleaned.trim();
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

    logger.info("[friction-guard] v3.0.0 — pre-generation constraint injection");

    try {
      const entries = loadEvidence();
      logger.info(`[friction-guard] Evidence registry: ${entries.length} entries loaded`);
      loadGrievanceDictionary(); // preload + log count
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

          // Forced-repetition detection
          const repetition = detectUserForcedRepetition(userText, userId);
          if (repetition.detected) {
            profile.signatures.repetition = clamp01(profile.signatures.repetition + 0.10);
            logFragment(userId, "user", userText.slice(0, 300), 2 as FrictionLevel, ["USER-FORCED-REPEAT"], 0, ["NO_REPETITION"], { repetition: 0.10 });
          }

          // Friction assessment
          const assessment = assessFriction(userText, profile, lang);

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
            logFragment(userId, "user", userText.slice(0, 300), assessment.level, assessment.matchedEntries.map((e) => e.id), assessment.baselineDeviation, assessment.constraintsToActivate, assessment.signatureUpdates);
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

          // Build injection
          const injection = buildConstraintPrompt(profile) + buildFrictionNote(assessment.level);

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
