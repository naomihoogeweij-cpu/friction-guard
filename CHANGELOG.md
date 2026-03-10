# Changelog

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


