// ──────────────────────────────────────────────
// Cold-Start Situation-First Protocol
//
// When turnCount < 5, injects contrastive
// few-shot examples to prime the model against
// frame errors. Removed once baseline established.
// ──────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PrimingExample { id: string; input: string; wrong_answer: string; right_answer: string; frame_error: string; principle: string; }
interface PrimingData { _meta: Record<string, any>; examples: PrimingExample[]; }

const COLD_START_THRESHOLD = 5;

let _cache: PrimingData | null = null;
const PRIMING_PATH = join(__dirname, "context-priming-examples.json");

export function loadPrimingExamples(): PrimingData | null {
  if (_cache) return _cache;
  if (!existsSync(PRIMING_PATH)) { console.warn(`[friction-guard] Priming examples not found at ${PRIMING_PATH}`); return null; }
  try {
    _cache = JSON.parse(readFileSync(PRIMING_PATH, "utf8"));
    console.info(`[friction-guard] Cold-start priming loaded: ${_cache!.examples.length} contrastive examples`);
    return _cache;
  } catch (e) { console.warn("[friction-guard] Failed to parse priming examples:", e); return null; }
}

export function isColdStart(turnCount: number): boolean { return turnCount < COLD_START_THRESHOLD; }

export function buildColdStartPrompt(turnCount: number): string {
  if (!isColdStart(turnCount)) return "";
  const data = loadPrimingExamples();
  if (!data || data.examples.length === 0) return "";
  const exampleBlock = data.examples.map((ex) =>
    `Example (${ex.id}):\n  User says: "${ex.input}"\n  Wrong: "${ex.wrong_answer}"\n  Right: "${ex.right_answer}"\n  Why: ${ex.frame_error}\n  Principle: ${ex.principle}`
  ).join("\n\n");
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
