# Changelog

## 4.1.0 (2026-04-11)

### EXECUTE_FIRST: behavioral pattern detection for confirm-without-deliver loops

Friction-guard v4.0 detected what the agent *says* but not what the agent *does*. When Rutka confirmed intent multiple times without executing (e.g., "Klopt, ik pak dat nu" → no tool call → "Ik ga het fixen" → no tool call), friction-guard stayed silent because the language was clean. Meanwhile the user escalated from "doe dan!" to caps to profanity.

v4.1 closes this gap with a new behavioral detection layer.

### New module: `friction-execute-first.ts`
- Turn-by-turn state machine tracking agent delivery vs confirmation
- `isConfirmWithoutDeliver()`: detects NL/EN confirmation language (klopt, snap, helder, genoteerd, ik pak, got it, on it, fixing...) in agent turns that contain zero `tool_use` blocks
- `processTurn()`: maintains per-user state across the conversation
- Compound trigger: `confirmWithoutDeliverCount >= 2` AND `userEscalationPeak >= L2` → `EXECUTE_FIRST` activates
- Reset: any agent turn with actual tool execution resets counter and deactivates override
- `getExecuteFirstPrompt()`: returns system prompt injection when active

### New evidence entries
- `AGENT-004` (`confirm_without_deliver`): behavioral pattern, computed detection, suggests `EXECUTE_FIRST`
- `AGENT-005` (`escalation_without_pivot`): compound trigger combining user L2+ escalation with agent stagnation

### New constraint: `EXECUTE_FIRST`
- Hard override injected into system prompt when compound trigger fires
- Rules: stop explaining, stop status updates, execute shortest path to result, report only the result
- Stays active until agent produces a concrete result (tool call with output)
- Threshold 0.5 (lower than other constraints — this pattern is severe)

### New signature: `confirm_without_deliver`
- Added to `Signature` type and `UserProfile`
- Tracked in `CONSTRAINT_THRESHOLDS` with threshold 0.5
- Incremented by 0.15 × consecutive confirm-without-deliver count

### Integration
- `index.ts`: imports `friction-execute-first`, maintains per-user `ExecuteFirstState` map
- `lastAgentHadToolCall()`: inspects message history for `tool_use`/`tool_call` blocks
- Wired into `before_prompt_build` hook after action-avoidance detection (which remains as fallback)
- Evidence registry bumped to v4.1.0 (18 entries: 13 user-side + 5 agent-side)

### Design decisions
- Behavioral detection supplements but does not replace linguistic detection
- `EXECUTE_NOW` (v3.5 string-matching fallback) preserved alongside `EXECUTE_FIRST` (v4.1 tool-tracking)
- State machine is per-user, in-memory (resets on process restart — acceptable for session-length patterns)
- No new API calls: detection uses existing message history already available in `before_prompt_build`

## 4.0.0 (2026-04-04)

### Semantic search integration
- New `semantic-expansion.py`: standalone embedding engine using OpenAI text-embedding-3-small
- Embeds miner n-grams and clusters semantically similar patterns (cosine threshold 0.80)
- Expands banned phrases with semantic variants from the irritation registry + miner corpus (threshold 0.82)
- Runs asynchronously in the background cycle (every 15 min), non-blocking
- Results cached in `memory/semantic/` for synchronous access in the hot path
- No API calls in `before_prompt_build` — all embedding work happens in background

### Ban expansion with concrete variants
- `buildConstraintPrompt()` now reads `expanded-bans.json` for semantic variants
- Instead of relying on the model to interpret "close variants", the HARD BAN list includes explicit alternative phrasings discovered by vector search
- Variants sourced from irritation registry (186 patterns) and miner n-gram corpus
- Maximum 8 variants per banned phrase, minimum cosine similarity 0.82

### N-gram semantic clustering
- Miner n-grams with ≥4 words are embedded and clustered by cosine similarity > 0.80
- Cluster observation counts are aggregated, lowering the effective promotion threshold for semantic variants
- "ik begrijp je frustratie" (2x) + "ik snap hoe frustrerend" (1x) + "ik kan me voorstellen" (2x) = cluster with 5x, reaching promotion threshold

### State summary for memory-core
- After each background cycle, writes `memory/friction-guard-state.md`
- Contains: active bans (with semantic variants), classifier candidates, promotable clusters, profile summaries, miner statistics
- memory-core indexes this file, making friction-guard's learned knowledge searchable via `memory_search`
- Closes the gap where learned interaction patterns were invisible to the broader memory system

### Architecture decisions
- Embedding in Python (semantic-expansion.py), not TypeScript: reuses existing infrastructure, runs as subprocess
- Pre-computation over real-time: all embedding in background cycles, cached for synchronous reads
- Graceful degradation: if cache files don't exist, original behaviour unchanged
- Risk mitigations documented: high thresholds prevent over-expansion, minimum n-gram length prevents false clusters, per-user data only (no cross-user leakage)

### Where semantic search was NOT added (by design)
- User input evidence matching: semantic similarity can't distinguish "ik heb je al gevraagd" (friction) from "ik heb haar al gevraagd" (neutral). Pattern-based matching preserved.
- Real-time pipeline: no embedding API calls in before_prompt_build (latency budget)
- Cold-start priming: corpus too small (4 examples) for semantic selection to matter
- Cross-user clustering: idiographic principle preserved

## 3.5.1 (2026-04-04)

### Action avoidance: transcript-based detection (bugfix)
- `detectActionAvoidanceLoop` now reads directly from session transcript JSONL instead of turn-history
- Fix: turn-history has no agent turns in `before_prompt_build` context, making the v3.5.0 detection non-functional
- Reads last 8KB of transcript via file descriptor (bounded, no full file load)
- Session ID resolved from sessions.json with user-specific match preference

### Code compaction
- `agent-irritation-classifier.ts`: removed verbose section headers and documentation comments
- `agent-irritation-matching.ts`: compact comments, removed redundant JSDoc
- `cold-start-priming.ts`: condensed header documentation to 3-line summary
- `openclaw.plugin.json`: extended description, reformatted activation block

## 3.5.0 (2026-03-25)

### Action avoidance detection (preflight pattern)
- New `action_avoidance` category in agent-irritation registry (14 NL + 12 EN patterns)
- Detects acknowledgment-without-action loops: agent says "ja, dat ga ik doen" repeatedly without executing
- New `EXECUTE_NOW` constraint injected when loop detected (2+ acknowledgments in last 3 agent turns)
- Integrates with existing friction-guard flow: same hook, same logging, same incident tracking

## 3.4.0 (2026-03-21)

### Cold-start situation-first protocol
- New `cold-start-priming.ts`: injects contrastive few-shot examples during early interactions (turnCount < 5)
- Priming block automatically removed once baseline established

## 3.3.0 (2026-03-21)

### Agent-side irritation detection
- New `agent-irritation-registry.json`: 7 evidence-based categories, ~100 NL + EN patterns
- LLM post-hoc classifier with candidate bank and promotion threshold
- Retroactive pattern miner: statistical n-gram analysis

## 3.2.0 (2026-03-10)

### Banned phrase enforcement + reduced false positives + input sanitizing

## 3.1.0 (2026-03-09)

### Grievance Dictionary integration (van der Vegt et al., 2021)

## 3.0.0 (2026-03-08)

Initial public release.
