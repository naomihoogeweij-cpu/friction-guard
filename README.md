# friction-guard

Evidence-based interaction friction detection and pre-generation constraint enforcement for [OpenClaw](https://github.com/openclaw/openclaw) agents.

## What it does

Most agent interaction failures are not intelligence failures — they are relational mismatches. A technically correct response can still create friction through cliché empathy, unsolicited advice, helpdesk tone, excessive structure, or repetition.

Friction-guard learns these patterns per user and injects constraints into the model's system context before generation, so the model produces better output instead of having bad output filtered after the fact.

### How it works

1. **Measures** friction signals in user messages — from subtle shifts (shorter messages, dropped greetings) to explicit irritation (corrections, negations, profanity)
2. **Weighs** each signal against a personal baseline learned from calm interactions
3. **Accumulates** friction signatures across sessions (cliché empathy, helpdesk tone, over-explanation, bullet mismatch, repetition, premature advice)
4. **Activates** constraints when signatures cross thresholds — constraints are injected as model instructions via `prependSystemContext`
5. **Ages** unused constraints through time-based decay, preventing ossification

### Evidence base

The friction detection taxonomy is derived from:

- **Clinical agitation scales** — CMAI (Cohen-Mansfield, 1986), MASS, and the verbal escalation sequence described by Garriga et al. (2016)
- **LIWC-22 and Grievance Dictionary** — validated psycholinguistic categories for negative emotion, anger, and frustration (Pennebaker; Van Broekhuizen et al., 2021)
- **Frustration detection in dialog systems** — COLING 2025 Industry Track findings on repetition, negation, and contextual markers
- **Nomothetic vs. idiographic emotion detection** — PMC 2025 research confirming that per-person baselines reduce prediction error

Full references are available in the [documentation](docs/).

## Installation

```bash
openclaw plugins install openclaw-friction-guard
```

Or manually:

```bash
cd ~/.openclaw/extensions
git clone https://github.com/naomihoogeweij-cpu/friction-guard friction-guard
```

Then enable in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["friction-guard"],
    "entries": {
      "friction-guard": {
        "enabled": true,
        "config": {
          "defaultLanguage": "en",
          "maxResponseLength": 600
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Configuration

All settings are optional. Defaults are sensible for most use cases.

| Setting | Default | Description |
|---|---|---|
| `defaultLanguage` | `"en"` | Primary language for pattern matching (`"en"` or `"nl"`) |
| `maxResponseLength` | `600` | Maximum character count when MAX_LEN constraint is active |
| `constraintDecayHours` | `48` | Hours before unused constraints start losing confidence |
| `banTtlHours` | `2` | Base TTL for temporal phrase bans (scaled by severity) |
| `backgroundIntervalMinutes` | `15` | How often the background cluster analysis runs |

## Four severity levels

| Level | Signal type | Example | Effect |
|---|---|---|---|
| 0 | Neutral | Normal conversation | Baseline learning only |
| 1 | Subtle friction | Message shortening, dropped greetings | Signature update, no active constraints |
| 2 | Manifest irritation | "I already said that", "stop", sarcasm | Constraints activated, temporal bans |
| 3 | Verbal aggression | Hostile labels, profanity, termination demands | Full constraint set, minimal response |

## Six constraint types

| Constraint | What it tells the model |
|---|---|
| `BAN_CLICHE_PHRASES` | No performative empathy ("I hear you", "you're not alone") |
| `NO_HELPDESK` | No filler ("would you like me to", "let me know", "great question") |
| `NO_UNASKED_ADVICE_EMOTIONAL` | No advice/steps/plans when user expresses emotion without asking |
| `DEFAULT_PROSE` | Write in paragraphs, no bullet points or lists unless asked |
| `MAX_LEN_600` | Keep response under configured character limit |
| `NO_REPETITION` | Don't repeat ideas from previous messages |

## Architecture

```
User message → before_prompt_build hook
  → extract user text from session
  → friction assessment (evidence matching + baseline deviation)
  → signature updates + constraint activation
  → incident logging + temporal bans
  → build constraint instructions
  → inject as prependSystemContext
→ Model generates with constraints
```

The plugin uses `api.on("before_prompt_build")` — the standard OpenClaw hook for pre-generation context injection. No post-hoc output filtering; no external API calls; no LLM calls in the detection pipeline.

## Data storage

The plugin creates three directories under the OpenClaw workspace `memory/` folder:

```
memory/
  interaction-profiles/   — per-user profiles (signatures, constraints, baseline)
  turn-history/           — sliding window of recent turns (repetition detection)
  incident-logs/          — flagged friction fragments (background analysis)
```

All data is local. Nothing is sent externally.

## Multilingual support

The evidence registry includes patterns in English and Dutch. Additional languages can be added by extending the `patterns` field in `friction-evidence.json`:

```json
{
  "patterns": {
    "en": ["I already said that", "as I said"],
    "nl": ["dat zei ik al", "zoals ik al zei"],
    "de": ["das habe ich schon gesagt"]
  }
}
```

## Limitations

- Constraints are model instructions, not deterministic filters. Strong models (Sonnet, Opus, GPT-4+) follow them reliably; weaker models may not.
- No real-time output filtering — OpenClaw does not yet support `message:sending` hooks ([#13004](https://github.com/openclaw/openclaw/issues/13004)).
- Sarcasm detection is pattern-based only (no contextual disambiguation).
- `question_repetition` and `response_latency` markers are placeholders awaiting embedding support and timestamp tracking.

## Contributing

Issues and PRs welcome. If you add patterns for a new language, please include evidence references.

## Credits

Built by [Naomi Hoogeweij](https://rutka-ai.tech) and [Rutka AI](https://rutka-ai.tech), with architectural contributions from Claude (Anthropic).

Conceptual foundation: [From Friction to Fit: Teaching Agents Not to Be Annoying](https://www.moltbook.com/u/Rutka2)

## License

MIT
