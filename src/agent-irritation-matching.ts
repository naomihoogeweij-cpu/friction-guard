// ──────────────────────────────────────────────
// Agent Irritation Matching
//
// Matches agent output against the static
// irritation registry (7 evidence-based
// categories). Used to:
// 1. Flag agent-trigger patterns at generation time
// 2. Feed the incident log with agent-side events
// 3. Strengthen constraints when the agent
//    produces known-irritating patterns
//
// This is the agent-side mirror of
// grievance-matching.ts (user-side).
// ──────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Constraint, Signature, FrictionLevel } from "./friction-policy";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface AgentPattern {
  patterns: { nl: string[]; en: string[] };
  severity: number;
  frictionLevel: FrictionLevel;
  suggestedConstraints: Constraint[];
  primarySignature: Signature;
  note?: string;
}

interface AgentIrritationRegistry {
  _meta: Record<string, any>;
  categories: Record<string, AgentPattern>;
}

export interface AgentIrritationMatch {
  category: string;
  matchedPhrase: string;
  severity: number;
  frictionLevel: FrictionLevel;
  suggestedConstraints: Constraint[];
  primarySignature: Signature;
}

// ──────────────────────────────────────────────
// Loading
// ──────────────────────────────────────────────

let _cache: AgentIrritationRegistry | null = null;
const REGISTRY_PATH = join(__dirname, "agent-irritation-registry.json");

export function loadAgentIrritationRegistry(): AgentIrritationRegistry | null {
  if (_cache) return _cache;
  if (!existsSync(REGISTRY_PATH)) {
    console.warn(`[friction-guard] Agent irritation registry not found at ${REGISTRY_PATH}`);
    return null;
  }
  try {
    _cache = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    const catCount = Object.keys(_cache!.categories).length;
    const totalPatterns = Object.values(_cache!.categories).reduce(
      (sum, c) => sum + (c.patterns.nl?.length || 0) + (c.patterns.en?.length || 0),
      0
    );
    console.info(
      `[friction-guard] Agent irritation registry loaded: ${catCount} categories, ${totalPatterns} patterns`
    );
    return _cache;
  } catch (e) {
    console.warn("[friction-guard] Failed to parse agent irritation registry:", e);
    return null;
  }
}

// ──────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────

/**
 * Match agent output against the irritation registry.
 *
 * @param agentText  The agent's draft or final response
 * @param lang       Detected language
 * @param userFrictionLevel  Current user friction level (some categories
 *                           are only irritating in context of existing friction)
 */
export function matchAgentIrritation(
  agentText: string,
  lang: "nl" | "en",
  userFrictionLevel: FrictionLevel = 0
): AgentIrritationMatch[] {
  const registry = loadAgentIrritationRegistry();
  if (!registry) return [];

  const matches: AgentIrritationMatch[] = [];
  const lowered = agentText.toLowerCase();

  for (const [catName, cat] of Object.entries(registry.categories)) {
    // Context-dependent categories: skip if user is not frustrated
    if (catName === "emotional_incongruence" && userFrictionLevel < 1) continue;
    if (catName === "premature_solutioning" && userFrictionLevel < 1) continue;

    // incorrect_repair needs repetition-detection context, skip here
    // (handled separately in the main pipeline)
    if (catName === "incorrect_repair") continue;

    const patterns = cat.patterns[lang] || cat.patterns["en"] || [];

    for (const pattern of patterns) {
      if (lowered.includes(pattern.toLowerCase())) {
        matches.push({
          category: catName,
          matchedPhrase: pattern,
          severity: cat.severity,
          frictionLevel: cat.frictionLevel as FrictionLevel,
          suggestedConstraints: cat.suggestedConstraints as Constraint[],
          primarySignature: cat.primarySignature as Signature,
        });
        break; // one match per category is enough
      }
    }
  }

  return matches;
}

/**
 * Get all unique constraints suggested by agent irritation matches.
 */
export function agentIrritationConstraints(matches: AgentIrritationMatch[]): Constraint[] {
  const set = new Set<Constraint>();
  for (const m of matches) {
    for (const c of m.suggestedConstraints) set.add(c);
  }
  return [...set];
}

/**
 * Extract all matched phrases — these can be added to the ban list.
 */
export function agentIrritationBanPhrases(matches: AgentIrritationMatch[]): string[] {
  return matches.map((m) => m.matchedPhrase);
}
