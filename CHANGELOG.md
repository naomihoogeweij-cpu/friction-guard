# Changelog

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


