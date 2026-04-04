# friction-guard v4.0.0 — Semantic Search Integration
## Design Document

**Datum:** 4 april 2026
**Status:** ontwerp + implementatie

---

## Analyse: waar semantic search waarde toevoegt

### 1. N-gram clustering in de miner (HOOGSTE PRIORITEIT)

**Probleem:** De miner trackt 21.892 n-grams maar heeft 0 promoted. De promotiedrempel (≥5 observaties, ≥60% frictie) wordt niet bereikt omdat semantisch identieke patronen apart geteld worden. "ik begrijp je frustratie" (2x), "ik snap hoe frustrerend" (1x), "ik kan me voorstellen" (2x) zijn dezelfde filler maar tellen als drie aparte n-grams die elk de drempel niet halen. Samen zouden ze 5x zijn en promoveren.

**Oplossing:** Embed alle kandidaat-n-grams, cluster op cosine similarity > 0.80, tel het cluster als geheel. Promotie geldt voor het hele cluster.

**Risico:** "niet goed" en "heel goed" kunnen clusteren door gedeeld "goed". Mitigatie: minimale n-gram lengte (≥4 woorden) voor clustering, en clusters alleen binnen dezelfde evidence-categorie.

### 2. Ban phrase expansion (HOOG)

**Probleem:** De HARD BAN-lijst zegt "close variants" maar het model bepaalt zelf wat dat zijn. "ik begrijp je frustratie" is gebanned, maar "ik snap hoe frustrerend dit is" niet.

**Oplossing:** Bij promotie van een ban, embed de frase en vergelijk tegen:
- De irritation registry (186 patronen, het bekende corpus)
- De miner n-gram database (21.892 patronen, het geleerde corpus)
Voeg alle matches boven cosine threshold 0.82 toe als expliciete varianten.

**Risico:** Over-expansion vangt oprechte empathie. "Dat klinkt moeilijk" (oprecht) vs "ik begrijp je frustratie" (filler). Mitigatie: hoge drempel (0.82), en alleen uitbreiden binnen dezelfde registry-categorie.

### 3. State summary naar .md (QUICK WIN)

**Probleem:** Friction-guard's geleerde kennis (bans, patronen, profielen) leeft in JSON-bestanden die memory-core niet indexeert. Rutka kan niet zoeken naar "wat heeft friction-guard geleerd".

**Oplossing:** Na elke achtergrondcyclus schrijf `memory/friction-guard-state.md`.

### 4. Registry-patroongroepen (MEDIUM)

**Probleem:** De irritation registry matcht op exact substring. 186 patronen dekken veel, maar niet alle varianten.

**Oplossing:** Pre-compute semantische groepen binnen de registry. Wanneer één patroon in een groep matcht, worden alle varianten in de groep automatisch ban-kandidaten (niet direct gebanned, maar gewogen in de constraint-prompt).

---

## Analyse: waar semantic search SCHADE doet

### 1. Evidence matching op user input — NIET IMPLEMENTEREN

Semantisch matchen op gebruikersinput zou "ik heb je al gevraagd" (frictie) niet onderscheiden van "ik heb haar al gevraagd" (neutraal). De huidige pattern-based matching is preciezer voor korte tekst met contextafhankelijke betekenis.

### 2. Real-time embedding in de hot path — NIET DOEN

`before_prompt_build` is synchroon. Embedding API-calls (100-200ms) in de hot path vertragen elke beurt. Alle embedding moet in achtergrondcycli draaien; resultaten worden gecached voor synchrone lezing.

### 3. Cross-user patroonlekkage — VOORKOMEN

Semantische clusters mogen alleen per gebruiker gevormd worden. Eén persoon's triggers mogen niet doorlekken naar een ander profiel. Idiografisch principe handhaven.

### 4. Embedding model drift — MITIGEREN

Cache bevat model-versie. Bij verandering van embedding model wordt de cache geïnvalideerd en opnieuw opgebouwd.

### 5. Cosine similarity op korte n-grams — VOORZICHTIG

Korte n-grams (2 woorden) hebben zwakke embeddings. "heel goed" en "niet goed" zijn semantisch tegengesteld maar kunnen door woordfrequentie toch hoog scoren. Minimale lengte: 4 woorden voor clustering, 3 woorden voor expansion.

---

## Architectuur

```
Achtergrondcyclus (elke 15 min)          Hot path (elke beurt)
┌───────────────────────────┐             ┌──────────────────────────┐
│ runPatternMining()        │             │ buildConstraintPrompt()  │
│   → extractNgrams         │             │   → read banned phrases  │
│   → embedNewNgrams (API)  │             │   → read ban-cache.json  │
│   → clusterBySimilarity   │             │     (expanded variants)  │
│   → countClusterTotals    │             │   → merge all into       │
│   → promoteIfThreshold    │             │     HARD BAN section     │
│   → writeSemanticCache    │             │   → return prompt        │
└───────────────────────────┘             └──────────────────────────┘
                                                    │
┌───────────────────────────┐             Geen API-calls in hot path.
│ runClassification() (24h) │             Alleen file reads.
│   → promote bans          │
│   → expandSemanticBans    │
│   → writeExpandedBanCache │
└───────────────────────────┘

┌───────────────────────────┐
│ writeStateSummary()       │
│   → memory/friction-guard │
│     -state.md             │
│   → memory-core indexeert │
└───────────────────────────┘
```

### Cache-bestanden (nieuw)

```
~/.openclaw/workspace/memory/semantic/
├── embedding-cache.json      ← phrase → vector (incrementeel)
├── ngram-clusters.json       ← cluster-id → [n-grams], counts
├── expanded-bans.json        ← original → [variants]
└── meta.json                 ← model version, last refresh
```

### Python vs TypeScript

Embedding-logica in Python (`semantic-expansion.py`) omdat:
- Hergebruikt embedding-infrastructuur uit memory_unified.py
- Synchrone HTTP via urllib (geen callback-complexiteit)
- Draait als subprocess, blokkeert de hook niet
- Bestaand patroon: memory_relational.py werkt zo

---

## Implementatieplan

### Stap 1: semantic-expansion.py
Commando's:
- `expand-bans` — embed banned phrases, zoek varianten, schrijf cache
- `cluster-ngrams` — embed + cluster miner n-grams, schrijf cache
- `refresh` — beide + state summary

### Stap 2: index.ts wijzigingen
- `buildConstraintPrompt()`: lees expanded-bans.json, voeg varianten toe
- Background cycle: roep `semantic-expansion.py refresh` aan via child_process
- Na cycle: schrijf `friction-guard-state.md`

### Stap 3: agent-pattern-miner.ts wijzigingen
- Lees ngram-clusters.json indien beschikbaar
- Tel cluster-totalen voor promotie
- Graceful degradation: als cache niet bestaat, origineel gedrag
