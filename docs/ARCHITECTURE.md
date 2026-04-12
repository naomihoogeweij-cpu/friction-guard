# friction-guard v4.2.0
## Functional and Technical Description

---

# Part I — Functional Description

## 1. The problem

Most interaction failures of AI agents are not knowledge failures. A response can be factually correct and still create friction: too much explanation at a vulnerable moment, unsolicited advice when someone wants to be heard, bullet lists where prose fits, or the same phrases repeated turn after turn. These are relational mismatches that, when they recur, erode trust — even when the model is technically capable.

The common pattern with agents is: the user corrects, the agent says "sorry, I'll do better," and the next time the exact same thing happens. The correction is session-scoped and evaporates at the next interaction. There is no learning process, no memory of what didn't work, and no mechanism to prevent recurrence.

## 2. What friction-guard does

friction-guard is a plugin for OpenClaw that learns interaction patterns and adjusts the agent's behaviour accordingly — not by filtering output after the fact, but by injecting constraints into the model's system context before generation.

The plugin does five things:

**Measure (user side):** On every incoming message, the plugin analyses the user's language for friction signals — from subtle shifts (shorter messages, disappearance of greetings) to explicit irritation (corrections, negations, profanity). Each signal is weighted against a personal baseline: what is normal for this user. Additionally, the Dutch Grievance Dictionary (van der Vegt et al., 2021) provides 556 Dutch and 464 English stemmed words across four friction-relevant categories.

**Measure (agent side):** The plugin detects irritating patterns in the agent's own output using a static irritation registry of ~100 phrases across seven evidence-based categories. An LLM post-hoc classifier and a statistical pattern miner continuously discover new irritating patterns from interaction data.

**Remember:** Friction signals are stored as signatures — weighted scores per category (cliché empathy, unsolicited advice, helpdesk tone, over-explanation, bullet lists, repetition). These scores persist across sessions and accumulate gradually. Dynamic bans discovered by the classifier and miner are stored in a candidate bank and promoted when confirmed.

**Constrain:** When a signature exceeds a threshold, a constraint is activated. Banned phrases — from static evidence, LLM-classified patterns, and miner-discovered n-grams — are injected as a HARD BAN section before all other constraints. The model knows, before it starts generating, what it should not do.

**Age:** Constraints not triggered for an extended period gradually lose strength. Temporal bans expire after a configurable period. Miner candidates not re-observed within 30 days are pruned. The system does not ossify.

## 3. The evidence base

### 3.1 User-side: clinical agitation scales

The Cohen-Mansfield Agitation Inventory (CMAI; Cohen-Mansfield, 1986) measures agitation across five domains. Garriga et al. (2016) describe the escalation sequence preceding agitation: hostile mood, increasing restlessness, louder speech, verbal threats. This escalation structure forms the basis for the four-level severity model.

### 3.2 User-side: linguistic marker analysis

LIWC-22 (Boyd et al., 2022) provides validated word lists for negative emotion and anger. The Grievance Dictionary (van der Vegt et al., 2021) adds granular categories — frustration, desperation, grievance, hate — with rated goodness-of-fit scores. The Dutch translation is integrated directly: 556 stemmed words with LIWC-style prefix matching and pre-compiled regexes.

### 3.3 User-side: frustration detection in human-agent interaction

Hernandez Caralt et al. (COLING 2025) identify four core markers: repetition of requests, negation, long unresolved conversations, and dissatisfaction without overt hostility. Hinrichs & Le (2018) confirmed that n-gram tokenization with stemming yielded the best classification results — the basis for the repetition detection module.

### 3.4 User-side: nomothetic vs. idiographic

Fisher et al. (2025) distinguish population-level models (between-people) from individual-level models (in-person). Idiographic models trained per person yield lower prediction errors, confirming that a personal baseline is necessary alongside population-level markers.

### 3.5 Agent-side: eight categories of agent-caused friction

**Sycophancy** — false validation, excessive agreement. Sharma et al. (2023, Anthropic) demonstrated pervasive sycophantic behaviour across five assistants, driven by RLHF reward signals.

**False humanity** — performative empathy without substance. Zheng et al. (2024, Emerald) identified this as a distinct failure mode. Users reported feeling betrayed, not comforted.

**Helpdesk filler** — empty responsiveness. Ozuem et al. (2024) found generic responses perceived as failing to acknowledge the situation.

**Overexplanation** — paternalistic elaboration. Bullet-pointing emotional topics, unsolicited pedagogical framing.

**Incorrect repair** — acknowledging a correction without changing. Pavone et al. (2023) describe this as a critical failure triggering intense negative responses.

**Emotional incongruence** — wrong register at the wrong moment. Brendel et al. (2023) showed human-like cues increase frustration in flawed interactions. Crolic et al. (2022) confirmed: warmth backfires when users are angry.

**Premature solutioning** — jumping to fixes before listening. Weiler et al. (2023) showed solution-oriented messages score on competence but not warmth.

**Action avoidance** — acknowledging what should be done without doing it. The agent says "yes, I should have done that" or "good point, I will" repeatedly without executing any tool call, file write, or command. This is a multi-turn pattern: a single acknowledgment is normal; two or more consecutive acknowledgments without action indicate a loop. The pattern is driven by RLHF reward signals that reinforce agreement and explanation over execution.

## 4. The four-level severity model

**Level 0 — Neutral.** Baseline language use. Only calm interactions update the personal baseline.

**Level 1 — Subtle friction.** Structural shifts: message shortening (>50% shorter than baseline), greeting dropout, question repetition. Individually weak — meaningful only when clustered.

**Level 2 — Manifest irritation.** Explicit correction, negation, imperative language, sarcasm, exasperation, disengagement threats. Activates constraints and temporal bans.

**Level 3 — Verbal aggression.** Hostile labels, directed profanity, termination demands. Full constraint activation.

## 5. Evidence registries

### 5.1 User-side evidence registry (friction-evidence.json)

16 entries across four levels, bilingual (NL+EN). Three types: pattern-matched verbal markers, computed structural markers, and agent-trigger entries.

### 5.2 Grievance Dictionary (grievance-dictionary.json)

590 NL / 475 EN stemmed words. Four categories from van der Vegt et al. (2021): frustration, desperation, grievance, hate. One custom category added in v4.2.0: dissatisfaction — 34 NL / 11 EN stems for everyday displeasure and implicit criticism ("meuk", "rommel", "puinhoop", "weer vol", "niks gebeurd", "schiet niet op"). This category maps to signature `confirm_without_deliver` and triggers the `EXECUTE_FIRST` constraint. Severity mapping: 7–10 rating → 0.3–0.9 friction severity. LIWC-style prefix matching. Early exit per category (max 3 matches). CC BY 4.0 licensed.

### 5.3 Agent-side irritation registry (agent-irritation-registry.json)

~100 NL/EN phrases across seven categories (§3.5). Each mapped to friction level, severity, constraints, and primary signature. Context-aware: emotional incongruence and premature solutioning only fire when user friction level ≥ 1.

## 6. Constraint types

| Constraint | Trigger | What the model receives |
|---|---|---|
| HARD BAN | Any active banned phrase | Specific phrase list, non-negotiable, first rule |
| BAN_CLICHE_PHRASES | cliche_empathy ≥ 0.7 | Avoid performative empathy |
| NO_HELPDESK | helpdesk_tone ≥ 0.6 | No helpdesk filler |
| NO_UNASKED_ADVICE_EMOTIONAL | premature_advice ≥ 0.7 | No advice in emotional context |
| DEFAULT_PROSE | bullet_mismatch ≥ 0.7 | Prose only, no bullets unless asked |
| MAX_LEN_600 | over_explain ≥ 0.7 | Maximum 600 characters |
| NO_REPETITION | repetition ≥ 0.6 | No repeated sentences or ideas |
| EXECUTE_FIRST | confirm_without_deliver ≥ 0.5 | Act first, explain after — no acknowledgment without execution |
| EXECUTE_NOW | action avoidance loop (2+/3 turns) | Execute immediately, no explanation or confirmation |

## 7. Dynamic ban discovery

### 7.1 LLM post-hoc classifier (agent-irritation-classifier.ts)

Runs daily. Extracts (agent-turn, user-friction-response) pairs from incident logs for level 2+ events. Sends at most 10 pairs per run to the model with a structured classification prompt. The model identifies problematic substrings, assigns categories and severity. Phrases flagged ≥3 times across separate incidents are promoted to the dynamic ban list. Candidates expire after 30 days.

### 7.2 Retroactive pattern miner (agent-pattern-miner.ts)

Runs every 15 minutes. Extracts bigrams, trigrams, and 4-grams from agent responses. Tracks per n-gram: friction count (before level 2+), calm count (before level 0), total. Promotion criteria: ≥5 observations, ≥60% friction rate, ≥2x lift over baseline friction rate. Stop-word filtering (NL+EN). Purely statistical — no LLM.

### 7.3 Ban convergence

Static evidence bans (TTL-bound), classifier-promoted bans, and miner-promoted patterns merge into one HARD BAN section at the top of the constraint prompt.

## 8. Cold-start situation-first protocol

When a user profile is new (fewer than 5 calm interactions), the plugin has no baseline and no learned constraints. This is the phase where frame errors are most likely: the model doesn't know the person yet, and may misread the situation behind the literal question.

During cold start, the plugin injects a `[SITUATION-FIRST PROTOCOL]` block into the system context containing contrastive few-shot examples. Each example shows a question where the literal reading diverges from the situational reading — and the principle that resolves it. For example: "Should I walk or drive to the car wash?" is not a question about how the person should travel, but about how the car gets there.

The priming block is automatically removed once the profile has enough calm interactions to establish a meaningful baseline. The examples are maintained in `context-priming-examples.json` and derived from real friction-guard incidents where the root cause was a frame error, not a knowledge error.

## 9. What the plugin does not do

- No deterministic output filtering. Constraints are instructions to the model, not regex filters.
- No emotion recognition. The plugin detects friction patterns, not emotions.
- No LLM calls in the real-time pipeline. The classifier runs offline (daily).

---

# Part II — Technical Description

## 1. Installation

### Via OpenClaw CLI

```bash
openclaw plugins install openclaw-friction-guard
openclaw plugins enable friction-guard
```

### Manual installation

```bash
git clone https://github.com/naomihoogeweij-cpu/friction-guard.git
mkdir -p ~/.openclaw/extensions/friction-guard
cp src/index.ts ~/.openclaw/extensions/friction-guard/

mkdir -p ~/.openclaw/workspace/interaction
cp src/friction-policy.ts src/friction-evidence.json \
   src/grievance-dictionary.json src/grievance-matching.ts \
   src/agent-irritation-registry.json src/agent-irritation-matching.ts \
   src/agent-irritation-classifier.ts src/agent-pattern-miner.ts \
   src/cold-start-priming.ts src/context-priming-examples.json \
   src/incident-log.ts src/repetition-detection.ts \
   src/background-analysis.ts \
   ~/.openclaw/workspace/interaction/

mkdir -p ~/.openclaw/workspace/memory/{interaction-profiles,incident-logs,turn-history,classifier,pattern-miner}

# Fix imports for server path layout
sed -i 's|from "./|from "../../workspace/interaction/|g' \
  ~/.openclaw/extensions/friction-guard/index.ts

# Create plugin manifest
cat > ~/.openclaw/extensions/friction-guard/openclaw.plugin.json << 'EOF'
{
  "name": "friction-guard",
  "id": "friction-guard",
  "version": "3.3.0",
  "description": "Evidence-based interaction friction detection and pre-generation constraint enforcement.",
  "entry": "index.ts",
  "configSchema": {},
  "activation": { "event": "agent.start" }
}
EOF

openclaw plugins enable friction-guard
systemctl --user restart openclaw-gateway
```

### Verify

```bash
openclaw plugins list | grep friction
```

Expected startup log:
```
[friction-guard] v3.4.0 — pre-generation constraint injection
[friction-guard] Evidence registry: 16 entries loaded
[friction-guard] Grievance dictionary loaded: 556 NL / 464 EN stems
[friction-guard] Agent irritation registry loaded: 7 categories, ~160 patterns
[friction-guard] Cold-start priming loaded: 4 contrastive examples
[friction-guard] Registered on before_prompt_build
```

## 2. File structure

```
~/.openclaw/extensions/friction-guard/
├── index.ts                          → Plugin entry, hook, orchestration
└── openclaw.plugin.json              → Plugin metadata

~/.openclaw/workspace/interaction/
├── friction-policy.ts                → Types, evidence loader, profile management
├── friction-evidence.json            → User-side evidence registry (16 entries)
├── grievance-dictionary.json         → Grievance Dictionary (556 NL / 464 EN stems)
├── grievance-matching.ts             → LIWC-style stem matching
├── agent-irritation-registry.json    → Agent-side patterns (7 categories, ~100 phrases)
├── agent-irritation-matching.ts      → Static agent-output matcher
├── agent-irritation-classifier.ts    → LLM post-hoc classifier (daily)
├── agent-pattern-miner.ts            → Statistical n-gram miner (every 15 min)
├── cold-start-priming.ts             → Situation-first protocol (turnCount < 5)
├── context-priming-examples.json     → Contrastive few-shot examples for cold start
├── incident-log.ts                   → Fragment logging
├── repetition-detection.ts           → N-gram Jaccard similarity
└── background-analysis.ts            → Periodic cluster analysis

~/.openclaw/workspace/memory/
├── interaction-profiles/{userId}.json
├── incident-logs/{userId}.json
├── turn-history/{userId}.json
├── classifier/classifier-state.json
└── pattern-miner/miner-state.json
```

## 3. Dataflow per request

```
User message arrives
        │
        ▼
before_prompt_build hook fires
        │
        ▼
stripChannelMetadata(text)        ← remove WhatsApp/channel envelope,
        │                            media markers, tool instructions
        ▼
extractLastUserMessage(messages)
        │
        ▼
readProfile(userId)
        │
        ├──► cleanExpiredBans()
        ├──► recordTurn(userId, "user", text)
        │
        ├──► assessFriction(text, profile, lang)
        │        ├──► matchUserInput()            ── evidence patterns (NL+EN)
        │        ├──► computeStructuralMarkers()  ── shortening, greeting dropout
        │        ├──► computeBaselineDeviation()   ── personal baseline deviation
        │        ├──► matchGrievance()             ── Grievance Dictionary stems
        │        └──► merge: level, entries, constraints, signature updates
        │
        ├──► detectUserForcedRepetition()  ← skipped if level ≥ 2
        │
        ├──► apply signature updates
        ├──► activate constraints
        ├──► logFragment() if level > 0
        ├──► addBan() for agent patterns at level ≥ 2
        ├──► updateBaseline() only at level 0
        ├──► inferConstraints(profile)
        ├──► writeProfile()
        │
        ├──► buildConstraintPrompt(profile)
        │        ├──► static bans (TTL-bound)
        │        ├──► getPromotedBans()     ← classifier
        │        ├──► getMinedPatterns()     ← miner
        │        └──► merge → HARD BAN (first rule) + constraint rules
        │
        ├──► buildColdStartPrompt(turnCount) ← situation-first priming if turnCount < 5
        │
        ├──► buildFrictionNote(level)
        │
        ├──► [every 15 min] runBackgroundAnalysis() + runPatternMining()
        ├──► [every 24h]    runClassification() via api.complete
        │
        ▼
return { prependSystemContext: coldStartBlock + constraintPrompt + frictionNote }
```

## 4. Input sanitisation

`stripChannelMetadata()` removes:
- `Conversation info (untrusted metadata):` + fenced JSON blocks
- `Sender (untrusted metadata):` + fenced JSON blocks
- Media markers: `[media attached: ...]`, `[audio message]`, etc.
- Tool instruction blocks: "To send an image back...", system instructions
- Cron/heartbeat wrapper lines
- Bootstrap truncation warnings (`[Bootstrap truncation warning]...`) — system context injected by OpenClaw when workspace files are truncated at bootstrap. Without stripping, this text passes through the Grievance Dictionary and causes false-positive friction scores. Added in v4.2.0.
- `System (untrusted):` exec result blocks — tool execution output appended to user messages
- Pre-compaction memory flush blocks — memory-core system instructions
- Inter-session message headers — agent-to-agent communication envelopes
- Queued-messages wrappers — system envelope for batched messages

## 5. Evidence registry schema

```typescript
interface EvidenceEntry {
  id: string;                    // "L2-001", "AGENT-002"
  level: 0 | 1 | 2 | 3;
  severity: number;              // 0..1
  type: "structural" | "verbal" | "agent_trigger";
  marker: string;
  patterns?: Record<string, string[]>;  // language → phrases
  detection: "pattern" | "computed" | "pattern_plus_context" | "semantic_similarity";
  contexts: ("emotional" | "technical" | "neutral")[];
  suggestedConstraints: Constraint[];
}
```

## 6. Profile schema

```typescript
interface UserProfile {
  userId: string;
  updatedAt: string;
  signatures: Record<Signature, number>;  // 6 categories, each 0..1
  constraints: { id: Constraint; enabled: boolean; confidence: number; lastTriggered?: string; }[];
  bannedPhrases: { phrase: string; severity: number; source: string; expiresAt: string; }[];
  baseline: {
    avgMessageLength: number;
    avgSentenceCount: number;
    greetingPresent: boolean;
    typicalResponseTimeMs: number;
    lastCalibrated: string;
    turnCount: number;
  };
  currentFrictionLevel: 0 | 1 | 2 | 3;
  recentTurnLengths: number[];  // sliding window, max 10
}
```

### Signature dynamics

Rise: L1 +0.03, L2 +0.08, L3 +0.15 per matched entry.
Decline: constraint decay (48h untriggered → -0.02/cycle), background de-escalation (isolated L1 after 2h → -0.01).

### Baseline learning

Updated exclusively from level-0 (calm) interactions. Exponentially diminishing weight: `alpha = min(0.1, 1/(turnCount+1))`.

## 7. Repetition detection

Weighted Jaccard: `trigrams × 0.5 + bigrams × 0.3 + words × 0.2`

**User forced-repetition:** Threshold 0.65, minimum 3 shared trigrams. Skipped at level ≥ 2.
**Agent self-repetition:** Threshold 0.55. Turn history only (no output hook).
**Storage:** 30-turn sliding window per user, text truncated to 500 chars.

## 8. Action avoidance loop detection

Runs every turn in `before_prompt_build`. Reads the last 3 agent turns from the turn-history (via `readHistory` from `repetition-detection.ts`). Matches each turn against acknowledgment patterns in the detected language (NL/EN).

**Detection threshold:** 2 or more matching turns out of the last 3.

**Patterns:** 14 NL + 12 EN acknowledgment phrases (e.g. "ja, dat had ik moeten doen", "good point, I will"). Supplemented over time by the daily classifier and pattern miner.

**On detection:** activates `EXECUTE_NOW` constraint and logs an incident at level 2 with signature update `helpdesk += 0.15`. The constraint instructs the model to execute the pending action in the current turn.

**Self-correcting:** when the agent starts executing (tool calls, file writes), subsequent turns no longer match and the constraint deactivates naturally.

## 9. Background analysis

Runs every 15 minutes. Three operations:
- **Temporal clustering:** fragments within 10 min grouped, effective level per cluster.
- **Escalation:** 3+ level-1 in one cluster → effective level 2.
- **De-escalation:** isolated level-1 without recurrence within 2h → signature decay.

## 10. Temporal ban mechanism

At level 2+, agent-trigger phrases are banned with TTL: `BASE_TTL × (0.5 + severity)`. BASE_TTL = 2 hours. Expired bans cleaned at start of each cycle.

## 11. Dependencies

None. Node.js standard library only: `node:fs`, `node:path`.

## 12. Self-inspection tooling

`scripts/friction_guard_inspect.py` provides on-demand inspection of friction-guard state. The primary command is `summary`, which outputs a pre-interpreted, relay-ready summary in Dutch — intended for the agent to pass through without further interpretation.

Commands:
- `summary` — current level, active constraints in plain Dutch, last 10 messages distribution, last friction event with context. Default command for reporting to the user.
- `status` — combined profile and last 5 incidents (raw data).
- `incidents --last N --min-level L` — filtered incident log with distribution and marker frequency.
- `profile` — full JSON profile dump.
- `explain` — architecture note on the difference between friction-guard and agent_strain_policy.

Design principle: the `summary` output requires no interpretation by the agent. This prevents the agent from misrepresenting data (e.g., confusing total distribution across all fragments with a recent window). The agent should relay the output, not summarise it.

## 13. Known limitations

| Limitation | Status |
|---|---|
| No deterministic output filtering | Awaiting OpenClaw `message:sending` hook (#13004) |
| LLM classifier requires api.complete | No-op if unavailable |
| Pattern miner needs data | Meaningful after ~50+ interactions |
| Sycophancy detection pattern-only | Classifier + miner discover new patterns |

---

## References

Boyd, R. L., et al. (2022). *The development and psychometric properties of LIWC-22*. University of Texas at Austin.
Brendel, A. B., et al. (2023). *JMIS, 40*(3), 883–913.
Cohen-Mansfield, J. (1986). *JAGS, 34*(10), 722–727.
Crolic, C., et al. (2022). *Journal of Marketing, 86*(1), 132–148.
Fisher, A. J., et al. (2025). Preprint. doi:10.21203/rs.3.rs-6414400/v1.
Garriga, M., et al. (2016). *World J Biol Psychiatry, 17*(2), 86–128.
Hernandez Caralt, J., et al. (2025). *COLING 2025, Industry Track*.
Hinrichs, H. & Le, N.-T. (2018). *32nd BCS HCI Conference*.
Ozuem, W., et al. (2024). *Psychology & Marketing, 41*(9), 2057–2078.
Pavone, G., et al. (2023). *J Interactive Marketing, 58*(1), 52–71.
Sharma, M., et al. (2023). *arXiv:2310.13548*.
van der Vegt, I., et al. (2021). *Behavior Research Methods, 53*, 2105–2119.
Weiler, S., et al. (2023). *Electronic Markets, 33*, Article 51.
Zheng, Y., et al. (2024). *IT & People, 37*(8), 175–199.

---

*friction-guard v3.5.0 — Naomi Hoogeweij, Rutka, and Claude Opus. March 2026.*
