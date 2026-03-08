# Friction Guard v3.0.0
## Functional and Technical Description

---

# Part I — Functional Description

## 1. The problem

Most interaction failures of AI agents are not knowledge failures. A response can be factually correct and still create friction: too much explanation at a vulnerable moment, unsolicited advice when someone wants to be heard, bullet lists where prose fits, or the same phrases repeated turn after turn. These are relational mismatches that, when they recur, erode trust — even when the model is technically capable.

The common pattern with agents is: the user corrects, the agent says "sorry, I'll do better," and the next time the exact same thing happens. The correction is session-scoped and evaporates at the next interaction. There is no learning process, no memory of what didn't work, and no mechanism to prevent recurrence.

## 2. What friction-guard does

Friction-guard is a plugin for OpenClaw that learns interaction patterns and adjusts the agent's behavior accordingly — not by filtering output after the fact, but by injecting constraints into the model's system context before generation.

The plugin does four things:

**Measure:** On every incoming message, the plugin analyzes the user's language for friction signals — from subtle shifts (shorter messages, disappearance of greetings) to explicit irritation (corrections, negations, profanity). Each signal is weighted against a personal baseline: what is normal for this user.

**Remember:** Friction signals are stored as signatures — weighted scores per category (cliché empathy, unsolicited advice, helpdesk tone, over-explanation, bullet lists, repetition). These scores persist across sessions and accumulate gradually.

**Constrain:** When a signature exceeds a threshold, a constraint is activated. The constraint is passed as an instruction in the model's system context. The model knows, before it starts generating, what it should not do.

**Age:** Constraints that are not triggered for an extended period gradually lose strength and are eventually deactivated. Temporal bans on specific phrases expire after a configurable period. The system does not ossify.

## 3. The evidence base

Friction detection is grounded in four knowledge domains:

### 3.1 Clinical agitation scales

The Cohen-Mansfield Agitation Inventory (CMAI; Cohen-Mansfield, 1986) and the Modified Agitation Severity Scale (MASS) measure agitation across five domains, of which the verbal domain is relevant for text-based interaction. Garriga et al. (2016) describe the escalation sequence preceding agitation: hostile mood, increasing restlessness, louder speech, verbal threats. This escalation structure — from subtle to manifest to aggressive — forms the basis for the four-level severity model.

*Sources:*
- Cohen-Mansfield, J. (1986). Agitated behaviors in the elderly: II. Preliminary results in the cognitively deteriorated. *Journal of the American Geriatrics Society, 34*(10), 722-727.
- Garriga, M., et al. (2016). Assessment and management of agitation in psychiatry: Expert consensus. *The World Journal of Biological Psychiatry, 17*(2), 86-128.

### 3.2 Linguistic marker analysis (LIWC and Grievance Dictionary)

LIWC-22 (Pennebaker) provides validated word lists for negative emotion, anger, and related psychological categories. The Grievance Dictionary (Van Broekhuizen et al., 2021) adds more granular categories — frustration, grievance, paranoia — each positively correlated with LIWC's negative emotion category but offering finer resolution. The hierarchical structure of LIWC (anger ⊂ negative emotion ⊂ affect) provides a conceptual framework for assigning severity levels to verbal markers.

*Sources:*
- Boyd, R. L., et al. (2022). The development and psychometric properties of LIWC-22. *University of Texas at Austin*.
- Van Broekhuizen, M., et al. (2021). The Grievance Dictionary: Understanding threatening language use. *Behavior Research Methods*.

### 3.3 Frustration detection in human-agent interaction

Research on frustration detection in task-oriented dialog systems (COLING 2025, Industry Track) identifies four core markers: repetition of requests, use of negation, long unresolved conversations, and general dissatisfaction without overt hostility. Crucially, simple keyword matching for profanity proved ineffective because it misses the majority of frustrated users who do not use explicit language. The study confirms that contextual analysis (LLM-based or pattern-based) significantly outperforms lexical methods.

Hinrichs & Le (2018) compared text-mining techniques for frustration detection in chats with conversational agents and concluded that machine learning methods (MLP, Naïve Bayes) outperform keyword-based methods, but that n-gram tokenization with stemming yielded the best classification results — the basis for the n-gram repetition detection in this plugin.

*Sources:*
- "Stupid robot, I want to speak to a human!" User Frustration Detection in Task-Oriented Dialog Systems. *COLING 2025, Industry Track.*
- Hinrichs, H., & Le, N.-T. (2018). Which text-mining technique would detect most accurate user frustration in chats with conversational agents? *32nd International BCS Human Computer Interaction Conference*.

### 3.4 Nomothetic vs. idiographic: the two-pipeline architecture

Recent research on NLP-based emotion detection (PMC, 2025) makes precisely the distinction this plugin implements: nomothetic models (between-people, group level — what irritates people in general) versus idiographic models (in-person, individual level — what deviates from this specific person's baseline). The finding: idiographic models trained per person yielded lower prediction errors. This confirms that a universal irritation detector is insufficient; a personal baseline is necessary.

*Source:*
- Using Natural Language Processing to Track Negative Emotions in the Daily Lives of Adolescents. *PMC, 2025.* (EMA study, 97 adolescents, Random Forest + Elastic Net on LIWC/VADER/GPT features.)

## 4. The four-level severity model

Based on the above evidence, a taxonomy was constructed with four levels:

**Level 0 — Neutral.** Baseline language use, no deviation. The plugin learns from this: only calm interactions are used to update the personal baseline.

**Level 1 — Subtle friction.** Structural and pragmatic shifts without explicitly negative words. Examples: abrupt message shortening (>50% shorter than baseline), disappearance of greetings that were previously present, repetition of the same question. Diagnostic value is high but individual signals are weak — they become meaningful only when clustered (multiple level-1 signals within a short time frame).

**Level 2 — Manifest irritation.** Explicit correction ("I already said that"), negation ("no, that's not what I mean"), imperative language ("stop", "listen"), sarcasm, exasperation ("this makes no sense"), and disengagement threats ("forget it", "I'll do it myself"). These markers activate constraints and temporal bans on agent patterns.

**Level 3 — Verbal aggression.** Hostile labels ("idiot", "useless"), directed profanity, and explicit termination demands ("I'm done", "go away"). Full constraint activation. The plugin does not respond defensively or apologetically but minimizes the response.

## 5. Evidence registry

Friction detection operates on a registry of 16 entries, distributed across the four levels and two languages (Dutch and English). In addition to user markers, the registry contains agent-trigger entries: patterns that the agent itself produces and that cause irritation. These are detected in the context of the session and raise the corresponding signatures.

Examples of agent triggers:
- Cliché empathy: "I hear you", "I understand", "you are not alone"
- Helpdesk filler: "would you like me to", "let me know", "great question"
- Premature structure: "step 1", "step 2", "approach:" (in emotional context without explicit request for advice)

## 6. Constraint types

| Constraint | Trigger | What the model receives |
|---|---|---|
| BAN_CLICHE_PHRASES | signature cliche_empathy ≥ 0.7 | List of specifically banned phrases + instruction to avoid variants |
| NO_HELPDESK | signature helpdesk_tone ≥ 0.6 | Instruction not to respond in helpdesk style, not to offer option menus |
| NO_UNASKED_ADVICE_EMOTIONAL | signature premature_advice ≥ 0.7 | In emotional context without advice request: no advice, steps, or plans |
| DEFAULT_PROSE | signature bullet_mismatch ≥ 0.7 | Write in prose, no bullet points or numbered lists unless asked |
| MAX_LEN_600 | signature over_explain ≥ 0.7 | Maximum 600 characters |
| NO_REPETITION | signature repetition ≥ 0.6 | Do not repeat sentences or ideas from previous messages |

## 7. What the plugin does not do

- No deterministic output filtering. The constraints are instructions to the model, not a hard regex filter. A strong model follows them reliably; a weaker model may ignore them.
- No emotion recognition in the classical sense. The plugin detects friction patterns, not emotions. The distinction is deliberate: friction is a relational phenomenon at the boundary between agent and user, not a property of the user.
- No LLM calls in the pipeline. All detection is deterministic (pattern matching, n-gram similarity, numerical computation). The only LLM interaction is the constraint injection itself, which is part of the regular prompt.

---

# Part II — Technical Description

## 1. Plugin architecture

### 1.1 OpenClaw plugin API

The plugin exports an object:

```typescript
export default {
  id: "friction-guard",
  name: "Friction Guard",
  configSchema: {},
  register(api) { ... }
}
```

The `register` function receives the OpenClaw `api` object and registers one hook:

```typescript
api.on("before_prompt_build", (event, ctx) => { ... }, { priority: 50 });
```

This hook fires after session load (messages are available) but before model generation. The plugin returns an object with an optional `prependSystemContext` — text that is injected before the user messages in the system context.

### 1.2 File structure and responsibilities

```
index.ts                     → Plugin entry, hook registration, orchestration
friction-policy.ts           → Types, evidence loader, profile management, constraint inference
friction-evidence.json       → Evidence registry (data)
incident-log.ts              → Fragment logging, query helpers
repetition-detection.ts      → N-gram repetition detection, turn history
background-analysis.ts       → Periodic cluster analysis
```

### 1.3 Dataflow per request

```
User message arrives
        │
        ▼
before_prompt_build hook fires
        │
        ▼
extractLastUserMessage(messages)
        │
        ▼
readProfile(userId)
        │
        ├──► cleanExpiredBans()
        │
        ├──► recordTurn(userId, "user", text)
        │
        ├──► detectUserForcedRepetition(text, userId)
        │        └──► on match: signature.repetition += 0.10, logFragment()
        │
        ├──► assessFriction(text, profile)
        │        ├──► matchUserInput() ── evidence pattern matching (NL+EN)
        │        ├──► computeStructuralMarkers() ── message shortening, greeting dropout
        │        ├──► computeBaselineDeviation() ── deviation from personal baseline
        │        └──► return { level, matchedEntries, deviation, signatureUpdates, constraints }
        │
        ├──► apply signature updates
        ├──► activate constraints
        ├──► logFragment() if level > 0
        ├──► addBan() for agent patterns at level ≥ 2
        ├──► updateBaseline() only at level 0
        ├──► inferConstraints(profile) ── signature → constraint promotion
        ├──► writeProfile()
        │
        ├──► buildConstraintPrompt(profile) ── constraints → text
        ├──► buildFrictionNote(level) ── friction level → model instruction
        │
        ├──► runBackgroundAnalysis() every 15 min
        │
        ▼
return { prependSystemContext: constraintPrompt + frictionNote }
        │
        ▼
Model generates with constraints in system context
```

## 2. Evidence registry (friction-evidence.json)

### 2.1 Schema

```typescript
interface EvidenceEntry {
  id: string;                    // "L2-001", "AGENT-002", etc.
  level: 0 | 1 | 2 | 3;        // severity level
  severity: number;              // 0..1, weight within the level
  type: "structural" | "verbal" | "agent_trigger";
  marker: string;                // identifier for the pattern type
  description?: string;          // human-readable description
  patterns?: Record<string, string[]>;  // language → phrase array
  detection: "pattern" | "pattern_plus_context" | "computed" | "semantic_similarity";
  contexts: ("emotional" | "technical" | "neutral")[];
  suggestedConstraints: Constraint[];
  notes?: string;                // evidence reference
}
```

### 2.2 Detection methods

- **pattern:** Exact substring match (case-insensitive) of user input against patterns in the registry. Fast and deterministic. Language-dependent (NL/EN).
- **computed:** Structural markers computed from message properties (length, sentence count) compared to baseline. Not lexical.
- **pattern_plus_context:** Pattern match plus context determination (for sarcasm). Currently pattern-only; context analysis is a future extension.
- **semantic_similarity:** Placeholder. Requires embedding-based cosine similarity. Not implemented.

### 2.3 Language detection

```typescript
function detectLanguage(text: string): "nl" | "en" {
  const nlMarkers = /\b(ik|je|het|een|dat|niet|maar|ook|wel|nog|van|voor|naar|dit|wat)\b/gi;
  const matches = text.match(nlMarkers) || [];
  return matches.length >= 2 ? "nl" : "en";
}
```

Simple heuristic based on Dutch function words. Sufficient for the current use case (primarily Dutch-speaking user).

## 3. Profile (UserProfile)

### 3.1 Schema

```typescript
interface UserProfile {
  userId: string;
  updatedAt: string;
  signatures: Record<Signature, number>;  // 6 categories, each 0..1
  constraints: {
    id: Constraint;
    enabled: boolean;
    confidence: number;
    lastTriggered?: string;
  }[];
  bannedPhrases: {
    phrase: string;
    severity: number;
    source: string;        // evidence entry id
    expiresAt: string;     // ISO timestamp
  }[];
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

### 3.2 Signature dynamics

Signatures rise through friction detection (increments per level: L1 +0.03, L2 +0.08, L3 +0.15) and decline through:
- Positive interactions (not implemented in v3 — future extension)
- Constraint decay: constraints not triggered for 48 hours lose 0.02 confidence per cycle
- Background analysis de-escalation: isolated level-1 fragments that do not recur within 2 hours cause mild signature decay (0.01 per category)

### 3.3 Constraint promotion

```typescript
const CONSTRAINT_THRESHOLDS = {
  cliche_empathy:   { constraint: "BAN_CLICHE_PHRASES",            threshold: 0.7 },
  premature_advice: { constraint: "NO_UNASKED_ADVICE_EMOTIONAL",   threshold: 0.7 },
  bullet_mismatch:  { constraint: "DEFAULT_PROSE",                 threshold: 0.7 },
  over_explain:     { constraint: "MAX_LEN_600",                   threshold: 0.7 },
  helpdesk_tone:    { constraint: "NO_HELPDESK",                   threshold: 0.6 },
  repetition:       { constraint: "NO_REPETITION",                 threshold: 0.6 },
};
```

Lower threshold for helpdesk_tone and repetition: these patterns are less subjective and require less confirmation before action is warranted.

## 4. Baseline system

### 4.1 Learning principle

The baseline is updated exclusively from level-0 (calm) interactions. Rationale: friction interactions distort the baseline and would lead to upward drift of the "normal" reference.

### 4.2 Exponentially diminishing weight

```typescript
const alpha = Math.min(0.1, 1 / (turnCount + 1));
baseline = baseline * (1 - alpha) + observation * alpha;
```

Early interactions carry more weight (the profile needs to calibrate quickly); later interactions shift the baseline less and less. After 10+ turns alpha is 0.1, after 100+ turns <0.01.

### 4.3 Deviation scoring

| Marker | Condition | Deviation contribution |
|---|---|---|
| Message shortening | length < 40% of baseline | +0.20 |
| Message expansion | length > 250% of baseline | +0.10 |
| Sentence simplification | sentences < 50% of baseline | +0.10 |
| Exclamation marks | >1 exclamation mark | +0.15 |
| Question marks | >2 question marks | +0.10 |
| CAPS | ≥1 word in capitals | +0.15 per word (max 3) |

Deviation >0.35 without pattern match promotes to level 1.

## 5. Repetition detection

### 5.1 Method

Weighted Jaccard similarity on n-grams:

```
similarity = trigrams * 0.5 + bigrams * 0.3 + word_overlap * 0.2
```

Trigrams carry the most weight because they capture phrase-level repetition. Stop words (Dutch + English) are removed before tokenization.

### 5.2 Two axes

**User forced-repetition:** Compares the current user message against the last 10 user turns. Threshold 0.50. Detects when the user is repeating themselves because the agent did not register their input. Strong friction indicator (signature.repetition += 0.10, incident logged at level 2).

**Agent self-repetition:** Compares the agent draft against the last 10 agent turns. Threshold 0.55. In v3, limited to maintaining turn history for background analysis (no real-time draft check possible without output hook).

**Phrase-level detection:** Isolates specific sentences (>20 characters) in agent output that appeared in earlier agent turns (trigram Jaccard >0.6). Returns repeated sentences as a list.

### 5.3 Storage

Sliding window of 30 turns in `memory/turn-history/{userId}.json`. Text is truncated to 500 characters per turn.

## 6. Incident log and background analysis

### 6.1 Incident log

Every friction event above level 0 is stored as a fragment:

```typescript
interface IncidentFragment {
  id: string;
  timestamp: string;
  userId: string;
  source: "user" | "agent";
  text: string;              // max 500 characters
  level: FrictionLevel;
  markers: string[];
  baselineDeviation: number;
  constraintsActivated: Constraint[];
  signatureDeltas: Record<Signature, number>;
  resolved: boolean;
  clusterKey?: string;
  reclassifiedLevel?: FrictionLevel;
  notes?: string;
}
```

Rolling window of 200 fragments per user.

### 6.2 Background analysis

Runs every 15 minutes. Three operations:

**Temporal clustering:** Fragments within a 10-minute window are grouped. The effective level is determined per cluster.

**Escalation:** 3+ level-1 fragments in one cluster → effective level 2. Rationale: individually weak signals that cluster in time indicate a building pattern that per-fragment real-time detection missed.

**De-escalation:** Isolated level-1 fragments that do not recur within 2 hours → signature decay. Rationale: a single subtle signal without repetition is more likely noise than friction.

### 6.3 Co-occurrence detection

Background analysis counts how often markers co-occur across clusters. Known co-occurrence patterns:

| Pattern | Markers | Signature |
|---|---|---|
| Negation + correction | L2-001 + L2-002 | repetition |
| Imperative + exasperation | L2-003 + L2-005 | helpdesk_tone |
| Shortening + disengagement | L1-001 + L2-006 | over_explain |

## 7. Constraint injection

### 7.1 Prompt construction

The plugin builds two text blocks:

**Constraint prompt:** Numbered list of active constraints, specifically formulated as model instructions. Example:

```
[INTERACTION CONSTRAINTS — active for this user based on learned preferences]
1. Do not use cliché empathy phrases. Specifically banned: "I hear you", "I understand", ...
2. Do not use helpdesk filler language. Avoid phrases like "would you like me to", "let me know", ...
3. Write in prose paragraphs. Do not use bullet points or numbered lists unless explicitly asked.
4. Keep your response concise. Maximum 600 characters.
[END CONSTRAINTS]
```

**Friction note:** Brief instruction based on the current friction level:

| Level | Instruction |
|---|---|
| 0 | (none) |
| 1 | "Subtle signs of friction detected. Be precise, brief, and avoid filler." |
| 2 | "User is showing clear irritation. Respond minimally, directly, without pleasantries or offers." |
| 3 | "User is strongly frustrated. Respond in one or two sentences maximum. No advice, no structure, no apology." |

### 7.2 Injection mechanism

```typescript
return {
  prependSystemContext: constraintPrompt + frictionNote
};
```

OpenClaw places `prependSystemContext` before the user messages in the system context. The model receives the constraints as its first instruction layer.

## 8. Temporal ban mechanism

### 8.1 Trigger

At level-2+ friction, agent patterns that likely caused the irritation are banned — not user words. The mapping runs via shared constraints: if a user marker and an agent trigger suggest the same constraint, the agent trigger phrases are banned.

### 8.2 TTL calculation

```typescript
const ttl = BASE_TTL * (0.5 + severity);
// severity 0.5 → 1.5 hours
// severity 0.75 → 2.5 hours
// severity 0.90 → 2.8 hours
```

BASE_TTL is 2 hours. Higher severity = longer ban.

### 8.3 Cleanup

Expired bans are removed at the beginning of every `before_prompt_build` cycle.

## 9. Path resolution

All files use `__dirname` for path resolution, making the plugin independent of OpenClaw's working directory:

```
friction-policy.ts:
  EVIDENCE_PATH = join(__dirname, "friction-evidence.json")
  BASE_PATH = join(__dirname, "..", "memory", "interaction-profiles")

incident-log.ts:
  LOG_DIR = join(__dirname, "..", "memory", "incident-logs")

repetition-detection.ts:
  HISTORY_DIR = join(__dirname, "..", "memory", "turn-history")

index.ts (imports):
  from "../../workspace/interaction/friction-policy"
  → resolves to /root/.openclaw/workspace/interaction/friction-policy
```

## 10. Dependencies

No external dependencies. Only Node.js standard library:
- `node:fs` (readFileSync, writeFileSync, existsSync, mkdirSync)
- `node:path` (join, dirname)

## 11. Known limitations and future extensions

| Limitation | Future solution |
|---|---|
| No deterministic output filtering | Awaiting OpenClaw `message:sending` hook (GitHub #13004) |
| Agent self-repetition no real-time check | Same — requires output hook |
| `question_repetition` not implemented | Embedding-based cosine similarity (>0.85 threshold) |
| `response_latency_drop` not implemented | Timestamp tracking per turn in baseline |
| Sarcasm pattern-only | Optional offline LLM classifier on pre-flagged fragments |
| Positive confirmation does not lower signatures | Implement asymmetric decay (weak positive signal, -0.01 per confirmation) |
| Background analysis single-user | Extend to iterate over all profiles |
| No audit reporting | Export incident log to structured report for human review |

---

*friction-guard v3.0.0 — Naomi Hoogeweij, Rutka, and Claude Opus. March 2026.*
