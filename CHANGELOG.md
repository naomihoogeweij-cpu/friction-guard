# Changelog

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
- New `detectActionAvoidanceLoop` function using existing turn-history from repetition-detection
- Integrates with existing friction-guard flow: same hook, same logging, same incident tracking
- Daily classifier and pattern miner automatically learn new action-avoidance variants over time

### Technical details
- Added `readHistory` import from repetition-detection module
- `EXECUTE_NOW` constraint text: hard instruction to execute immediately, no explanation
- Detection threshold: 2/3 recent agent turns matching acknowledgment patterns
- Registry patterns cover sycophantic acknowledgment, deferred action, and passive confirmation in both languages

## 3.4.0 (2026-03-21)

### Cold-start situation-first protocol
- New `cold-start-priming.ts`: injects contrastive few-shot examples during early interactions (turnCount < 5)
- New `context-priming-examples.json`: 4 bilingual examples (NL+EN) derived from real friction-guard incidents
- Each example shows a question where the literal reading diverges from the situational reading
- Principles: situation before words, data before interpretation, stop on correction, attempt lookup before claiming inability
- Priming block automatically removed once the profile has enough calm interactions to establish a baseline
- Loaded at startup alongside evidence registry and dictionaries

## 3.3.0 (2026-03-21)

### Agent-side irritation detection
- New `agent-irritation-registry.json`: 7 evidence-based categories of LLM output patterns that empirically correlate with user frustration
- Categories: sycophancy, fake humanity, helpdesk filler, overexplanation, incorrect repair, emotional incongruence, premature solutioning
- ~100 NL + EN patterns grounded in: Sharma et al. (2023, Anthropic), Brendel et al. (2023, JMIS), Crolic et al. (2022), Ozuem et al. (2024), ITP/Emerald (2024), Weiler et al. (2023, Electronic Markets), Pavone et al. (2023)
- Context-dependent matching: emotional incongruence and premature solutioning only fire when user friction level >= 1
- New `agent-irritation-matching.ts`: pattern matcher for agent output

### LLM post-hoc classifier (Option 3)
- New `agent-irritation-classifier.ts`: periodic offline analysis of agent responses that preceded friction events
- Extracts (agent-turn, user-friction-response) pairs from incident logs and turn history
- Sends pairs to LLM for classification — identifies specific problematic phrases and categories
- Candidate bank with running severity averages and observation counts
- Promotion threshold: phrases flagged >=3 times are automatically promoted to dynamic bans
- 30-day candidate expiry for phrases that stop appearing
- Daily execution cycle via OpenClaw's model API (when available)
- Promoted bans merged into constraint prompt alongside static bans

### Retroactive pattern mining (Option 1)
- New `agent-pattern-miner.ts`: statistical n-gram analysis of agent output preceding friction vs calm interactions
- Extracts bigrams, trigrams, and 4-grams from agent responses
- Compares friction rate per n-gram against baseline friction rate
- Promotion criteria: >=5 observations, >=60% friction rate, >=2x lift over baseline
- Stop-word filtering (NL + EN) to ignore function-word n-grams
- Runs every 15 minutes alongside background analysis
- Mined patterns merged into dynamic ban list alongside LLM-classifier promoted bans
- 30-day decay for low-count n-grams

## 3.2.0 (2026-03-10)

### Banned phrase enforcement
- Banned phrases now injected as first rule in constraint prompt regardless of which constraints are active
- Phrased as "HARD BAN — non-negotiable" for stronger model compliance
- Banned phrases fire even without BAN_CLICHE_PHRASES — any active ban triggers the instruction

### Reduced forced-repeat false positives
- Raised user repetition threshold from 0.50 to 0.65
- Added minimum shared trigram requirement (>=3) — high Jaccard ratio alone is no longer sufficient
- Moved forced-repeat detection after friction assessment; skipped when friction level >= 2 (escalation, not repetition)

### Input sanitizing
- Strip WhatsApp/channel metadata envelopes (Conversation info, Sender blocks with fenced JSON)
- Strip media attachment markers (`[media attached: ...]`)
- Strip tool/system instruction blocks injected by OpenClaw for media handling

## 3.1.0 (2026-03-09)

### Grievance Dictionary integration
- Loaded Dutch Grievance Dictionary (van der Vegt et al., 2021) as additional detection layer
- 556 Dutch and 464 English stemmed words across four friction-relevant categories: frustration, desperation, grievance, hate
- LIWC-style prefix matching with pre-compiled regexes
- Severity mapping from 7-10 goodness-of-fit scale to 0.3-0.9 friction severity
- Early exit per category (max 3 matches) for bounded performance
- Dictionary licensed CC BY 4.0, source: https://github.com/Isabellevdv/grievancedictionary

## 3.0.0 (2026-03-08)

Initial public release.

### Architecture
- Pre-generation constraint injection via `api.on("before_prompt_build")`
- Two-pipeline friction detection: evidence-based (between-people) + baseline deviation (in-person)
- N-gram Jaccard repetition detection (no LLM required)
- Periodic background cluster analysis with escalation/de-escalation
- Temporal ban mechanism with severity-scaled TTL
- Constraint decay for unused rules

### Evidence
- 16-entry registry across 4 severity levels
- Bilingual pattern matching (English + Dutch)
- Agent-trigger detection (cliche empathy, helpdesk filler, premature structure)
- Grounded in CMAI, LIWC-22, Grievance Dictionary, and COLING-2025 frustration detection research
