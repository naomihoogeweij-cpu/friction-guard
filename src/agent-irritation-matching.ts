// ──────────────────────────────────────────────
// Agent Irritation Matching
//
// Matches agent output against the static
// irritation registry (7 evidence-based
// categories). Agent-side mirror of
// grievance-matching.ts (user-side).
// ──────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Constraint, Signature, FrictionLevel } from "./friction-policy";

interface AgentPattern { patterns: { nl: string[]; en: string[] }; severity: number; frictionLevel: FrictionLevel; suggestedConstraints: Constraint[]; primarySignature: Signature; note?: string; }
interface AgentIrritationRegistry { _meta: Record<string, any>; categories: Record<string, AgentPattern>; }
export interface AgentIrritationMatch { category: string; matchedPhrase: string; severity: number; frictionLevel: FrictionLevel; suggestedConstraints: Constraint[]; primarySignature: Signature; }

let _cache: AgentIrritationRegistry | null = null;
const REGISTRY_PATH = join(__dirname, "agent-irritation-registry.json");

export function loadAgentIrritationRegistry(): AgentIrritationRegistry | null {
  if (_cache) return _cache;
  if (!existsSync(REGISTRY_PATH)) { console.warn(`[friction-guard] Agent irritation registry not found at ${REGISTRY_PATH}`); return null; }
  try {
    _cache = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    const catCount = Object.keys(_cache!.categories).length;
    const totalPatterns = Object.values(_cache!.categories).reduce((sum, c) => sum + (c.patterns.nl?.length || 0) + (c.patterns.en?.length || 0), 0);
    console.info(`[friction-guard] Agent irritation registry loaded: ${catCount} categories, ${totalPatterns} patterns`);
    return _cache;
  } catch (e) { console.warn("[friction-guard] Failed to parse agent irritation registry:", e); return null; }
}

export function matchAgentIrritation(agentText: string, lang: "nl" | "en", userFrictionLevel: FrictionLevel = 0): AgentIrritationMatch[] {
  const registry = loadAgentIrritationRegistry();
  if (!registry) return [];
  const matches: AgentIrritationMatch[] = [];
  const lowered = agentText.toLowerCase();
  for (const [catName, cat] of Object.entries(registry.categories)) {
    if (catName === "emotional_incongruence" && userFrictionLevel < 1) continue;
    if (catName === "premature_solutioning" && userFrictionLevel < 1) continue;
    if (catName === "incorrect_repair") continue;
    const patterns = cat.patterns[lang] || cat.patterns["en"] || [];
    for (const pattern of patterns) {
      if (lowered.includes(pattern.toLowerCase())) {
        matches.push({ category: catName, matchedPhrase: pattern, severity: cat.severity, frictionLevel: cat.frictionLevel as FrictionLevel, suggestedConstraints: cat.suggestedConstraints as Constraint[], primarySignature: cat.primarySignature as Signature });
        break;
      }
    }
  }
  return matches;
}

export function agentIrritationConstraints(matches: AgentIrritationMatch[]): Constraint[] {
  const set = new Set<Constraint>();
  for (const m of matches) for (const c of m.suggestedConstraints) set.add(c);
  return [...set];
}

export function agentIrritationBanPhrases(matches: AgentIrritationMatch[]): string[] {
  return matches.map((m) => m.matchedPhrase);
}
