// ──────────────────────────────────────────────
// Cold-Start Situation-First Protocol
//
// When a user profile is new (turnCount below
// threshold), the plugin has no baseline and no
// learned constraints. This is the moment where
// frame errors are most likely: the model doesn't
// know the person yet, and may misread the
// situation behind the literal question.
//
// This module injects contrastive few-shot
// examples into the system context during cold
// start. Each example shows a question where the
// literal reading diverges from the situational
// reading. The model learns: check the situation
// before answering the words.
//
// After the baseline is established (turnCount
// exceeds threshold), the priming is removed and
// the learned constraints take over.
// ──────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface PrimingExample {
  id: string;
  input: string;
  wrong_answer: string;
  right_answer: string;
  frame_error: string;
  principle: string;
}

interface PrimingData {
  _meta: Record<string, any>;
  examples: PrimingExample[];
}

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

// Priming is active until the profile has this many calm turns
const COLD_START_THRESHOLD = 5;

// ──────────────────────────────────────────────
// Loading
// ──────────────────────────────────────────────

let _cache: PrimingData | null = null;
const PRIMING_PATH = join(__dirname, "context-priming-examples.json");

export function loadPrimingExamples(): PrimingData | null {
  if (_cache) return _cache;
  if (!existsSync(PRIMING_PATH)) {
    console.warn(`[friction-guard] Priming examples not found at ${PRIMING_PATH}`);
    return null;
  }
  try {
    _cache = JSON.parse(readFileSync(PRIMING_PATH, "utf8"));
    console.info(
      `[friction-guard] Cold-start priming loaded: ${_cache!.examples.length} contrastive examples`
    );
    return _cache;
  } catch (e) {
    console.warn("[friction-guard] Failed to parse priming examples:", e);
    return null;
  }
}

// ──────────────────────────────────────────────
// Cold-start check
// ──────────────────────────────────────────────

/**
 * Returns true if the profile is in cold-start phase.
 * Cold start = not enough calm interactions to have
 * a meaningful baseline.
 */
export function isColdStart(turnCount: number): boolean {
  return turnCount < COLD_START_THRESHOLD;
}

// ──────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────

/**
 * Build the cold-start priming block for the
 * system context. Returns empty string if not
 * in cold-start phase or if no examples loaded.
 */
export function buildColdStartPrompt(turnCount: number): string {
  if (!isColdStart(turnCount)) return "";

  const data = loadPrimingExamples();
  if (!data || data.examples.length === 0) return "";

  const exampleBlock = data.examples
    .map((ex) =>
      `Example (${ex.id}):\n` +
      `  User says: "${ex.input}"\n` +
      `  Wrong: "${ex.wrong_answer}"\n` +
      `  Right: "${ex.right_answer}"\n` +
      `  Why: ${ex.frame_error}\n` +
      `  Principle: ${ex.principle}`
    )
    .join("\n\n");

  return (
    "\n\n[SITUATION-FIRST PROTOCOL — active during early interactions]\n" +
    "You are in an early phase with this person. You do not yet have learned " +
    "constraints or a reliable baseline. During this phase, apply extra caution:\n" +
    "- Before answering, identify the SITUATION behind the question, not just the literal words.\n" +
    "- When the user refers to a system, tool, or data source, attempt the lookup before claiming inability.\n" +
    "- When the user corrects an assumption, stop and ask — do not retry the wrong path.\n" +
    "- Default to showing actual data over offering interpretation.\n" +
    "- Keep responses concise until you know what this person prefers.\n\n" +
    "Contrastive examples (wrong vs. right framing):\n\n" +
    exampleBlock +
    "\n[END SITUATION-FIRST PROTOCOL]\n"
  );
}
