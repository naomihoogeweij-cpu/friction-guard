# friction-guard v4.0.0
## Functional and Technical Description

---

# Part I — Functional Description

## 1. The problem

Most interaction failures of AI agents are not knowledge failures. A response can be factually correct and still create friction: too much explanation at a vulnerable moment, unsolicited advice when someone wants to be heard, bullet lists where prose fits, or the same phrases repeated turn after turn. These are relational mismatches that, when they recur, erode trust — even when the model is technically capable.

The common pattern with agents is: the user corrects, the agent says "sorry, I'll do better," and the next time the exact same thing happens. The correction is session-scoped and evaporates at the next interaction. There is no learning process, no memory of what didn't work, and no mechanism to prevent recurrence.

## 2. What friction-guard does

friction-guard is a plugin for OpenClaw that learns interaction patterns and adjusts the agent's behaviour accordingly — not by filtering output after the fact, but by injecting constraints into the model's system context before generation.

The plugin does six things:

**Measure (user side):** On every incoming message, the plugin analyses the user's language for friction signals — from subtle shifts (shorter messages, disappearance of greetings) to explicit irritation (corrections, negations, profanity). Each signal is weighted against a personal baseline: what is normal for this user. Additionally, the Dutch Grievance Dictionary (van der Vegt et al., 2021) provides 556 Dutch and 464 English stemmed words across four friction-relevant categories.

**Measure (agent side):** The plugin detects irritating patterns in the agent's own output using a static irritation registry of ~186 phrases across eight evidence-based categories. An LLM post-hoc classifier and a statistical pattern miner continuously discover new irritating patterns from interaction data.

**Remember:** Friction signals are stored as signatures — weighted scores per category (cliché empathy, unsolicited advice, helpdesk tone, over-explanation, bullet lists, repetition). These scores persist across sessions and accumulate gradually. Dynamic bans discovered by the classifier and miner are stored in a candidate bank and promoted when confirmed.

**Constrain:** When a signature exceeds a threshold, a constraint is activated. Banned phrases — from static evidence, LLM-classified patterns, miner-discovered n-grams, and their semantic variants — are injected as a HARD BAN section before all other constraints. The model knows, before it starts generating, what it should not do.

**Expand (v4.0):** Banned phrases are semantically expanded using vector embeddings (OpenAI text-embedding-3-small). When "ik begrijp je frustratie" is banned, the system finds concrete variants like "ik snap hoe frustrerend dit is" and "ik kan me voorstellen dat dit lastig is" by computing cosine similarity against the irritation registry and miner corpus. Similarly, the miner's n-gram candidates are semantically clustered so that variants of the same filler pattern count together for promotion.

**Age:** Constraints not triggered for an extended period gradually lose strength. Temporal bans expire after a configurable period. Miner candidates not re-observed within 30 days are pruned. The system does not ossify.

## 3. The evidence base

### 3.1–3.4 User-side

Clinical agitation scales (CMAI; Cohen-Mansfield, 1986), linguistic marker analysis (LIWC-22; Boyd et al., 2022; Grievance Dictionary; van der Vegt et al., 2021), frustration detection in human-agent interaction (Hernandez Caralt et al., COLING 2025; Hinrichs & Le, 2018), and nomothetic vs. idiographic modelling (Fisher et al., 2025). See previous versions for full descriptions.

### 3.5 Agent-side: eight categories of agent-caused friction

Sycophancy (Sharma et al., 2023), false humanity (Zheng et al., 2024), helpdesk filler (Ozuem et al., 2024), overexplanation, incorrect repair (Pavone et al., 2023), emotional incongruence (Brendel et al., 2023; Crolic et al., 2022), premature solutioning (Weiler et al., 2023), and action avoidance.

## 4. The four-level severity model

**Level 0 — Neutral.** Baseline language use. Only calm interactions update the personal baseline.
**Level 1 — Subtle friction.** Structural shifts: message shortening, greeting dropout, question repetition.
**Level 2 — Manifest irritation.** Explicit correction, negation, imperative language, sarcasm, disengagement threats.
**Level 3 — Verbal aggression.** Hostile labels, directed profanity, termination demands.

## 5. Evidence registries

### 5.1 User-side evidence registry — 16 entries, bilingual (NL+EN), three types.
### 5.2 Grievance Dictionary — 556 NL / 464 EN stems, CC BY 4.0.
### 5.3 Agent-side irritation registry — ~186 NL/EN phrases across eight categories.

## 6. Constraint types

| Constraint | Trigger | What the model receives |
|---|---|---|
| HARD BAN | Any active banned phrase + semantic variants | Explicit phrase list including vector-expanded variants, non-negotiable, first rule |
| BAN_CLICHE_PHRASES | cliche_empathy ≥ 0.7 | Avoid performative empathy |
| NO_HELPDESK | helpdesk_tone ≥ 0.6 | No helpdesk filler |
| NO_UNASKED_ADVICE_EMOTIONAL | premature_advice ≥ 0.7 | No advice in emotional context |
| DEFAULT_PROSE | bullet_mismatch ≥ 0.7 | Prose only, no bullets unless asked |
| MAX_LEN_600 | over_explain ≥ 0.7 | Maximum 600 characters |
| NO_REPETITION | repetition ≥ 0.6 | No repeated sentences or ideas |
| EXECUTE_NOW | action avoidance loop (2+/3 turns) | Execute immediately, no explanation or confirmation |

## 7. Dynamic ban discovery

### 7.1 LLM post-hoc classifier

Runs daily. Extracts (agent-turn, user-friction-response) pairs from incident logs for level 2+ events. Phrases flagged ≥3 times are promoted to the dynamic ban list. Candidates expire after 30 days.

### 7.2 Retroactive pattern miner

Runs every 15 minutes. Extracts n-grams from agent responses. Promotion criteria: ≥5 observations, ≥60% friction rate, ≥2x lift over baseline.

### 7.3 Semantic ban expansion (v4.0)

When a phrase is promoted (by classifier or miner) or a temporal ban is created (by friction event), the semantic expansion engine embeds it using text-embedding-3-small and searches for variants in two corpora: the irritation registry (186 patterns) and the miner's n-gram database. Variants above cosine similarity 0.82 are added to the expanded ban cache (maximum 8 per phrase). The HARD BAN list includes these variants explicitly — the model receives concrete alternative phrasings to avoid, not just the instruction "close variants."

### 7.4 Semantic n-gram clustering (v4.0)

The miner's n-gram candidates are embedded and clustered by cosine similarity > 0.80 (minimum 4-word n-grams). Observation counts are aggregated within each cluster, lowering the effective promotion threshold. "ik begrijp je frustratie" (2x) + "ik snap hoe frustrerend" (1x) + "ik kan me voorstellen" (2x) = cluster with 5x total, reaching the promotion threshold that no individual variant would reach alone.

### 7.5 Ban convergence

Static evidence bans (TTL-bound), classifier-promoted bans, miner-promoted patterns, and their semantic variants merge into one HARD BAN section at the top of the constraint prompt.

## 8. Cold-start situation-first protocol

When a user profile is new (fewer than 5 calm interactions), the plugin injects contrastive few-shot examples. Automatically removed once baseline established.

## 9. Action avoidance loop detection

Reads the last 8KB of the active session transcript JSONL via bounded file descriptor read. Session ID resolved from `sessions.json` with user-specific match preference. Detection threshold: 2+ matching turns out of last 3. Self-correcting: deactivates when agent starts executing.

## 10. State summary for memory-core (v4.0)

After each background cycle, friction-guard writes `memory/friction-guard-state.md` containing: active bans (with semantic variants), classifier candidates, promotable semantic clusters, profile summaries, and miner statistics. This file is indexed by OpenClaw's memory-core plugin, making friction-guard's learned knowledge searchable via `memory_search`. This closes the gap where learned interaction patterns were invisible to the broader memory system.

## 11. What the plugin does not do

- No deterministic output filtering. Constraints are instructions to the model, not regex filters.
- No emotion recognition. The plugin detects friction patterns, not emotions.
- No LLM calls in the real-time pipeline. Classifier runs daily, semantic expansion runs every 15 minutes — both in background.
- No semantic matching on user input. Pattern-based matching is more precise for short, context-dependent text where pronoun distinctions matter.
- No cross-user pattern sharing. Idiographic principle preserved — each profile is independent.

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
cp src/*.ts src/*.json src/*.py ~/.openclaw/workspace/interaction/

mkdir -p ~/.openclaw/workspace/memory/{interaction-profiles,incident-logs,turn-history,classifier,pattern-miner,semantic}

sed -i 's|from "./|from "../../workspace/interaction/|g' \
  ~/.openclaw/extensions/friction-guard/index.ts

openclaw plugins enable friction-guard
```

### Verify

Expected startup log:
```
[friction-guard] v4.0.0 — pre-generation constraint injection
[friction-guard] Evidence registry: 16 entries loaded
[friction-guard] Grievance dictionary loaded: 556 NL / 464 EN stems
[friction-guard] Agent irritation registry loaded: 8 categories, 186 patterns
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
├── agent-irritation-registry.json    → Agent-side patterns (8 categories, ~186 phrases)
├── agent-irritation-matching.ts      → Static agent-output matcher
├── agent-irritation-classifier.ts    → LLM post-hoc classifier (daily)
├── agent-pattern-miner.ts            → Statistical n-gram miner (every 15 min)
├── semantic-expansion.py             → Vector embedding engine (every 15 min, async)
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
├── pattern-miner/miner-state.json
├── friction-guard-state.md           → State summary (indexed by memory-core)
└── semantic/
    ├── embedding-cache.json          → Cached phrase embeddings
    ├── ngram-clusters.json           → Semantic n-gram clusters
    ├── expanded-bans.json            → Ban → variant mappings
    └── meta.json                     → Model version, thresholds, last refresh
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
        ├──► detectActionAvoidanceLoop()   ← reads session transcript JSONL
        │
        ├──► apply signature updates, activate constraints
        ├──► logFragment() if level > 0
        ├──► addBan() for agent patterns at level ≥ 2
        ├──► updateBaseline() only at level 0
        ├──► inferConstraints(profile), writeProfile()
        │
        ├──► buildConstraintPrompt(profile)
        │        ├──► static bans (TTL-bound)
        │        ├──► getPromotedBans()            ← classifier
        │        ├──► getMinedPatterns()            ← miner
        │        ├──► loadExpandedBanVariants()     ← semantic cache (v4.0)
        │        └──► merge → HARD BAN (first rule) + constraint rules
        │
        ├──► buildColdStartPrompt(turnCount)
        ├──► buildFrictionNote(level)
        │
        ├──► [every 15 min] runBackgroundAnalysis()
        │                   runPatternMining()
        │                   triggerSemanticRefresh()  ← async subprocess (v4.0)
        │                     ├── cluster-ngrams (embed + cosine clustering)
        │                     ├── expand-bans (embed + variant search)
        │                     └── state-summary (write friction-guard-state.md)
        │
        ├──► [every 24h] runClassification() via api.complete
        │
        ▼
return { prependSystemContext: coldStartBlock + constraintPrompt + frictionNote }
```

## 4. Semantic expansion architecture (v4.0)

### Embedding engine

`semantic-expansion.py` runs as a Python subprocess, invoked asynchronously by `triggerSemanticRefresh()` via `node:child_process`. It uses OpenAI text-embedding-3-small (1536 dimensions) via direct HTTP calls. Embeddings are cached incrementally in `embedding-cache.json` — only uncached phrases are embedded per run. Maximum 200 embeddings per run (API cost control), batched in groups of 100.

### Clustering

Greedy single-pass clustering: for each unassigned n-gram, find all unassigned n-grams with cosine similarity ≥ 0.80. Form a cluster, aggregate observation counts. Only n-grams with ≥4 words and ≥3 observations are considered. Clusters with ≥5 aggregated observations and ≥60% friction rate are flagged as promotable.

### Ban expansion

For each active ban (from classifier, miner, or temporal bans), compute cosine similarity against the irritation registry (186 patterns) and miner n-gram corpus (phrases with ≥3 words). Variants above 0.82 similarity are added to the expanded ban cache. Maximum 8 variants per ban phrase.

### Where semantic search is NOT applied

- **User input matching:** semantic similarity cannot distinguish "ik heb je al gevraagd" (friction: "I already asked you") from "ik heb haar al gevraagd" (neutral: "I already asked her"). Pattern-based matching is more precise for short, context-dependent text.
- **Real-time pipeline:** no embedding API calls in `before_prompt_build`. All embedding happens in the background cycle. The hot path reads only cached results via synchronous file I/O.
- **Cross-user patterns:** clusters are formed from the global n-gram corpus but applied per-user. No leakage of one user's friction triggers to another user's constraint set.

### Risk mitigations

- **Over-expansion threshold:** 0.82 cosine similarity is conservative. Genuine empathy ("dat klinkt moeilijk") and performative filler ("ik begrijp je frustratie") are semantically distinct enough to remain separated at this threshold.
- **Minimum n-gram length:** 4 words for clustering, 3 words for expansion. Prevents false clusters from short, ambiguous fragments.
- **Embedding model versioning:** cache stores model identifier. If the embedding model changes, cache is invalidated and rebuilt.
- **Graceful degradation:** if cache files don't exist or semantic-expansion.py is unavailable, friction-guard operates with its original (pre-v4.0) behaviour unchanged.

## 5–12. Schemas, detection, analysis, bans, dependencies, limitations

Unchanged from v3.5.1. See §5–12 in previous version for evidence registry schema, profile schema, signature dynamics, baseline learning, repetition detection details, background analysis, temporal ban mechanism, dependencies (Node.js standard library only + Python 3 for semantic expansion), and known limitations.

### Updated known limitations (v4.0)

| Limitation | Status |
|---|---|
| No deterministic output filtering | Awaiting OpenClaw `message:sending` hook (#13004) |
| LLM classifier requires api.complete | No-op if unavailable |
| Pattern miner needs data | Semantic clustering helps aggregate sparse signals |
| Sycophancy detection pattern-only | Classifier + miner + semantic expansion discover variants |
| Semantic expansion requires OpenAI API | Graceful degradation if unavailable |
| Embedding model drift | Cache versioned, invalidated on model change |

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

*friction-guard v4.0.0 — Naomi Hoogeweij, Rutka, and Claude Opus. April 2026.*
