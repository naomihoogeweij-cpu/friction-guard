import { readProfile, writeProfile, type UserProfile, type FrictionLevel, clamp01 } from "./friction-policy";

// ──────────────────────────────────────────────
// friction-execute-first.ts  —  v4.1.0
//
// Behavioral pattern detection that friction-policy.ts
// cannot cover: tracks agent ACTIONS (not words) across
// turns and activates EXECUTE_FIRST when the agent
// confirms without delivering while the user escalates.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TurnRecord {
  role: "user" | "assistant";
  text: string;
  /** Did this assistant turn contain at least one tool_use block? */
  hasToolCall?: boolean;
  /** Did this assistant turn produce a concrete result (file, move, data)? */
  hasResult?: boolean;
  /** Detected user friction level for this turn (0-3) */
  frictionLevel?: FrictionLevel;
  timestamp?: string;
}

export interface ExecuteFirstState {
  /** Consecutive assistant turns with confirmation but no tool call */
  confirmWithoutDeliverCount: number;
  /** Current max user friction level in this sequence */
  userEscalationPeak: FrictionLevel;
  /** Whether EXECUTE_FIRST is currently active */
  active: boolean;
  /** Timestamp of last activation */
  activatedAt?: string;
}

// ──────────────────────────────────────────────
// Confirmation detection (agent-side)
// ──────────────────────────────────────────────

const CONFIRM_PATTERNS_NL = [
  /\b(klopt|snap|helder|begrijp|begrepen|genoteerd|check|fix|pak|draai|zet)\b/i,
  /\bik\s+(ga|zal|doe|heb|ben\s+bezig|pak\s+het|fix\s+het|check\s+het|draai)\b/i,
  /\b(gedaan|afgehandeld|geregeld|opgelost)\b/i,
];

const CONFIRM_PATTERNS_EN = [
  /\b(got it|understood|on it|fixing|checking|running|noted|will do)\b/i,
  /\bi('ll| will|'m going to|'m on it)\b/i,
  /\b(done|handled|resolved|sorted)\b/i,
];

/**
 * Returns true if the agent turn contains confirmation/intent language
 * but no actual tool execution or result.
 */
export function isConfirmWithoutDeliver(turn: TurnRecord): boolean {
  if (turn.role !== "assistant") return false;
  if (turn.hasToolCall || turn.hasResult) return false;

  const text = turn.text;
  const patterns = [...CONFIRM_PATTERNS_NL, ...CONFIRM_PATTERNS_EN];
  return patterns.some((p) => p.test(text));
}

// ──────────────────────────────────────────────
// State machine
// ──────────────────────────────────────────────

export function createExecuteFirstState(): ExecuteFirstState {
  return {
    confirmWithoutDeliverCount: 0,
    userEscalationPeak: 0,
    active: false,
  };
}

/**
 * Process a new turn and update the EXECUTE_FIRST state.
 *
 * Rules:
 * - Assistant turn with confirmation but no tool/result → increment counter
 * - Assistant turn WITH tool/result → reset counter
 * - User turn with L2+ friction → update peak
 * - Compound trigger: counter >= 2 AND peak >= 2 → activate EXECUTE_FIRST
 * - Reset: any assistant turn that delivers resets everything
 */
export function processTurn(
  state: ExecuteFirstState,
  turn: TurnRecord
): ExecuteFirstState {
  const next = { ...state };

  if (turn.role === "assistant") {
    if (turn.hasToolCall || turn.hasResult) {
      next.confirmWithoutDeliverCount = 0;
      next.active = false;
    } else if (isConfirmWithoutDeliver(turn)) {
      next.confirmWithoutDeliverCount += 1;
    }
  }

  if (turn.role === "user" && turn.frictionLevel !== undefined) {
    next.userEscalationPeak = Math.max(
      next.userEscalationPeak,
      turn.frictionLevel
    ) as FrictionLevel;
  }

  // Compound trigger
  if (
    next.confirmWithoutDeliverCount >= 2 &&
    next.userEscalationPeak >= 2 &&
    !next.active
  ) {
    next.active = true;
    next.activatedAt = new Date().toISOString();
  }

  return next;
}

// ──────────────────────────────────────────────
// Constraint instruction (for system prompt injection)
// ──────────────────────────────────────────────

export const EXECUTE_FIRST_INSTRUCTION = `⚠️ EXECUTE_FIRST OVERRIDE ACTIVE
The user has escalated and you have confirmed intent without delivering results multiple times.

RULES — effective immediately:
1. Do NOT explain what you are about to do.
2. Do NOT give status updates or ask for clarification.
3. Execute the shortest path to the requested result NOW.
4. Report ONLY the result after execution.
5. If execution fails, report the failure and your next concrete action — not an explanation of why it failed.

This override stays active until you produce a concrete result (tool call with output, file created, task completed).`;

// ──────────────────────────────────────────────
// Integration helper
// ──────────────────────────────────────────────

/**
 * Given the current state, returns the system prompt addition
 * if EXECUTE_FIRST is active, or null otherwise.
 */
export function getExecuteFirstPrompt(
  state: ExecuteFirstState
): string | null {
  return state.active ? EXECUTE_FIRST_INSTRUCTION : null;
}

/**
 * Update the user profile's signature for confirm_without_deliver.
 * Call this at the end of each turn cycle.
 */
export function updateProfileSignature(
  profile: UserProfile,
  state: ExecuteFirstState
): void {
  const sig = "confirm_without_deliver" as any;
  if (profile.signatures[sig] === undefined) {
    profile.signatures[sig] = 0;
  }
  if (state.confirmWithoutDeliverCount > 0) {
    profile.signatures[sig] = clamp01(
      profile.signatures[sig] + 0.15 * state.confirmWithoutDeliverCount
    );
  }
}
