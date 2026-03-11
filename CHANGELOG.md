# Changelog

## 3.3.0 (2026-03-11)

### Cold-start situation-first protocol
- New always-on context priming layer injected via `prependSystemContext` on every prompt
- Three-step protocol: (1) situatie-reconstructie — reconstruct the practical situation and implicit goal, (2) disambiguatie — check for multiple readings based on capitalization, punctuation, word order, and tone, (3) antwoord — answer the intention, name ambiguity when unsure
- Adapts to profile maturity: full protocol with contrastive examples for new users (turnCount < 10) or users with high repetition signature; compact protocol for established profiles
- Contrastive examples stored in `context-priming-examples.json` — maintainable from incident logs without code changes
- Profile-aware adaptive priors: adds user-specific instructions when signatures indicate recurring patterns (e.g., high helpdesk_tone → "do not offer options when intent is clear")
- Zero latency impact: pure string concatenation, no API calls, no LLM calls

### Intent-mismatch detection
- New detection layer for frame errors: when the user corrects a misunderstanding of their intent (not a factual error or repetition)
- Bilingual pattern matching (NL/EN) for phrases like "dat bedoel ik niet", "je luistert niet", "that's not what I mean", "you're not listening"
- Two severity tiers: mild (0.4, e.g., "ik bedoelde...") and strong (0.7, e.g., "je luistert niet")
- Strong intent mismatch promotes to level 2; mild to level 1
- Activates NO_HELPDESK + NO_REPETITION constraints
- Updates repetition and helpdesk_tone signatures proportionally
- Logged as INTENT-MISMATCH marker in incident log for background analysis
- Dedicated friction note for intent mismatch: instructs model to re-read and respond to actual intent

### Architecture
- `buildFrictionNote()` now accepts intent-mismatch result and generates mismatch-specific model instructions
- `assessFriction()` return type extended with `intentMismatch` field
- Injection order: cold-start protocol → constraint block → friction note
- Version bump to 3.3.0

## 3.2.0 (2026-03-10)

### Reduced forced-repeat false positives
- Raised user repetition threshold from 0.50 to 0.65
- Added minimum shared trigram requirement (≥3) — high Jaccard ratio alone is no longer sufficient
- Moved forced-repeat detection after friction assessment; skipped when friction level ≥ 2 (escalation, not repetition)

### Input sanitizing
- Strip WhatsApp/channel metadata envelopes (Conversation info, Sender blocks with fenced JSON)
- Strip media attachment markers (`[media attached: ...]`)
- Strip tool/system instruction blocks injected by OpenClaw for media handling

## 3.1.0 (2026-03-09)

### Grievance Dictionary integration
- Loaded Dutch Grievance Dictionary (van der Vegt et al., 2021) as additional detection layer
- 556 Dutch and 464 English stemmed words across four friction-relevant categories: frustration, desperation, grievance, hate
- LIWC-style prefix matching with pre-compiled regexes
- Severity mapping from 7–10 goodness-of-fit scale to 0.3–0.9 friction severity
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
- Agent-trigger detection (cliché empathy, helpdesk filler, premature structure)
- Grounded in CMAI, LIWC-22, Grievance Dictionary, and COLING-2025 frustration detection research
