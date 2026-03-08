// ──────────────────────────────────────────────
// Grievance Dictionary integration
//
// Loads friction-relevant categories (frustration,
// desperation, grievance, hate) from the Dutch
// Grievance Dictionary (van der Vegt et al., 2021)
// and matches stemmed words against user input.
//
// Stems are LIWC-style: "kwad" matches "kwaad",
// "kwaadheid", etc. Matching is word-boundary
// prefix matching.
// ──────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Constraint, Signature, FrictionLevel } from "./friction-policy";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface StemEntry {
  stem: string;
  severity: number;
  regex?: RegExp; // compiled on load
}

interface GrievanceCategory {
  frictionLevel: FrictionLevel;
  suggestedConstraints: Constraint[];
  primarySignature: Signature;
  words: {
    nl: StemEntry[];
    en: StemEntry[];
  };
}

interface GrievanceDictionary {
  _meta: Record<string, any>;
  categories: Record<string, GrievanceCategory>;
}

export interface GrievanceMatch {
  category: string;
  stem: string;
  severity: number;
  frictionLevel: FrictionLevel;
  suggestedConstraints: Constraint[];
  primarySignature: Signature;
}

// ──────────────────────────────────────────────
// Loading
// ──────────────────────────────────────────────

let _cache: GrievanceDictionary | null = null;

const DICT_PATH = join(__dirname, "grievance-dictionary.json");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadGrievanceDictionary(): GrievanceDictionary | null {
  if (_cache) return _cache;

  if (!existsSync(DICT_PATH)) {
    console.warn(`[friction-guard] Grievance dictionary not found at ${DICT_PATH}`);
    return null;
  }

  try {
    const raw: GrievanceDictionary = JSON.parse(readFileSync(DICT_PATH, "utf8"));

    // Pre-compile regexes for each stem
    for (const cat of Object.values(raw.categories)) {
      for (const lang of ["nl", "en"] as const) {
        for (const entry of cat.words[lang]) {
          // Word-boundary prefix match: "kwad" matches "kwaad", "kwaadheid"
          // For multi-word stems ("kort lontj"), match as substring
          if (entry.stem.includes(" ")) {
            entry.regex = new RegExp(escapeRegExp(entry.stem), "i");
          } else {
            entry.regex = new RegExp(`\\b${escapeRegExp(entry.stem)}\\w*\\b`, "i");
          }
        }
      }
    }

    _cache = raw;
    const totalNl = Object.values(raw.categories).reduce((sum, c) => sum + c.words.nl.length, 0);
    const totalEn = Object.values(raw.categories).reduce((sum, c) => sum + c.words.en.length, 0);
    console.info(`[friction-guard] Grievance dictionary loaded: ${totalNl} NL / ${totalEn} EN stems`);
    return raw;
  } catch (e) {
    console.warn("[friction-guard] Failed to parse grievance dictionary:", e);
    return null;
  }
}

// ──────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────

/**
 * Match user input against the Grievance Dictionary.
 * Returns all matches sorted by severity (highest first).
 *
 * Uses early exit per category: stops after first 3 matches
 * per category to keep performance bounded.
 */
export function matchGrievance(
  userText: string,
  lang: "nl" | "en"
): GrievanceMatch[] {
  const dict = loadGrievanceDictionary();
  if (!dict) return [];

  const matches: GrievanceMatch[] = [];
  const lowered = userText.toLowerCase();

  for (const [catName, cat] of Object.entries(dict.categories)) {
    const words = cat.words[lang] || cat.words["en"] || [];
    let catMatches = 0;

    for (const entry of words) {
      if (catMatches >= 3) break; // early exit per category
      if (entry.regex && entry.regex.test(lowered)) {
        matches.push({
          category: catName,
          stem: entry.stem,
          severity: entry.severity,
          frictionLevel: cat.frictionLevel as FrictionLevel,
          suggestedConstraints: cat.suggestedConstraints as Constraint[],
          primarySignature: cat.primarySignature as Signature,
        });
        catMatches++;
      }
    }
  }

  // Sort by severity descending
  matches.sort((a, b) => b.severity - a.severity);
  return matches;
}

/**
 * Get the highest friction level from grievance matches.
 */
export function grievanceFrictionLevel(matches: GrievanceMatch[]): FrictionLevel {
  if (matches.length === 0) return 0;
  return Math.max(...matches.map((m) => m.frictionLevel)) as FrictionLevel;
}

/**
 * Get all unique constraints suggested by grievance matches.
 */
export function grievanceConstraints(matches: GrievanceMatch[]): Constraint[] {
  const set = new Set<Constraint>();
  for (const m of matches) {
    for (const c of m.suggestedConstraints) set.add(c);
  }
  return [...set];
}

/**
 * Get signature updates from grievance matches.
 * Aggregates severity per primary signature.
 */
export function grievanceSignatureUpdates(
  matches: GrievanceMatch[]
): Partial<Record<Signature, number>> {
  const updates: Partial<Record<Signature, number>> = {};
  for (const m of matches) {
    const current = updates[m.primarySignature] || 0;
    // Diminishing returns: each additional match adds less
    updates[m.primarySignature] = current + m.severity * 0.02 * (1 / (current * 10 + 1));
  }
  return updates;
}
