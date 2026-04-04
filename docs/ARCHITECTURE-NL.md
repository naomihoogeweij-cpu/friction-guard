# friction-guard v4.0.0
## Functionele en technische beschrijving

---

# Deel I — Functionele beschrijving

## 1. Wat het probleem is

De meeste interactiefouten van AI-agents zijn geen kennisfouten. Een antwoord kan inhoudelijk correct zijn en toch frictie opleveren: te veel uitleg op een kwetsbaar moment, ongevraagd advies wanneer iemand gehoord wil worden, opsommingen waar proza past, of dezelfde zinnen die keer op keer terugkomen. Dit zijn relationele mismatches die, wanneer ze zich herhalen, vertrouwen ondermijnen.

Het gangbare patroon bij agents is: de gebruiker corrigeert, de agent zegt "sorry, ik doe het beter", en de volgende keer gebeurt precies hetzelfde. De correctie is session-scoped en verdampt bij de volgende interactie. Er is geen leerproces, geen geheugen voor wat niet werkte, en geen mechanisme om herhaling te voorkomen.

## 2. Wat friction-guard doet

friction-guard is een plugin voor OpenClaw die interactiepatronen leert en op basis daarvan het gedrag van de agent aanpast — niet door output achteraf te filteren, maar door constraints mee te geven aan het model vóór generatie.

De plugin doet zes dingen:

**Meten (gebruikerskant):** Bij elk inkomend bericht analyseert de plugin het taalgebruik op frictiesignalen — van subtiele verschuivingen (kortere berichten, wegvallen van begroetingen) tot expliciete irritatie (correcties, ontkenningen, scheldwoorden). Elk signaal wordt gewogen tegen een persoonlijke baseline. De Grievance Dictionary (Van der Vegt et al., 2021) biedt 556 NL en 464 EN gestemde woorden.

**Meten (agentkant):** De plugin detecteert irritante patronen in de eigen output via een statisch irritatieregister van ~186 zinnen over acht categorieën. Een LLM post-hoc classifier en een statistische patroonminer ontdekken doorlopend nieuwe patronen.

**Onthouden:** Frictiesignalen worden opgeslagen als signatures — gewogen scores per categorie. Dynamic bans worden opgeslagen in een kandidatenbank en gepromoveerd wanneer bevestigd.

**Begrenzen:** Wanneer een signature een drempel overschrijdt, wordt een constraint geactiveerd. Gebannen zinnen — inclusief hun semantische varianten — worden geïnjecteerd als HARD BAN-sectie vóór alle andere constraints.

**Uitbreiden (v4.0):** Gebannen zinnen worden semantisch uitgebreid met vector-embeddings (OpenAI text-embedding-3-small). Wanneer "ik begrijp je frustratie" gebanned is, vindt het systeem concrete varianten als "ik snap hoe frustrerend dit is" en "ik kan me voorstellen dat dit lastig is" door cosine-similarity te berekenen tegen het irritatieregister en het miner-corpus. De miner's n-gram-kandidaten worden ook semantisch geclusterd zodat varianten van hetzelfde patroon samen tellen voor promotie.

**Verouderen:** Constraints die langere tijd niet getriggerd worden verliezen geleidelijk kracht. Temporele bans verlopen. Miner-kandidaten die binnen 30 dagen niet opnieuw geobserveerd worden, worden opgeruimd.

## 3. De wetenschappelijke basis

Acht categorieën van agentgeroepen frictie: sycophancy (Sharma et al., 2023), valse menselijkheid (Zheng et al., 2024), helpdesk-vulling (Ozuem et al., 2024), overuitleg, incorrecte reparatie (Pavone et al., 2023), emotionele incongruentie (Brendel et al., 2023; Crolic et al., 2022), premature oplossing (Weiler et al., 2023), en actievermijding. Gebruikerskant gebaseerd op CMAI, LIWC-22, Grievance Dictionary, en COLING 2025 frustratiedetectie. Zie ARCHITECTURE.md (EN) voor volledige beschrijvingen en referenties.

## 4. Het vierniveau-ernstmodel

**Niveau 0 — Neutraal.** Baseline taalgebruik.
**Niveau 1 — Subtiele frictie.** Structurele verschuivingen.
**Niveau 2 — Manifeste irritatie.** Expliciete correctie, ontkenning, sarcasme.
**Niveau 3 — Verbale agressie.** Vijandige labels, gerichte scheldwoorden.

## 5. Constraint-typen

| Constraint | Trigger | Wat het model ontvangt |
|---|---|---|
| HARD BAN | Elke gebannen zin + semantische varianten | Expliciete zinnenlijst inclusief vector-uitgebreide varianten |
| BAN_CLICHE_PHRASES | cliche_empathy ≥ 0.7 | Vermijd performatieve empathie |
| NO_HELPDESK | helpdesk_tone ≥ 0.6 | Geen helpdesk-vulzinnen |
| NO_UNASKED_ADVICE_EMOTIONAL | premature_advice ≥ 0.7 | Geen advies in emotionele context |
| DEFAULT_PROSE | bullet_mismatch ≥ 0.7 | Alleen proza |
| MAX_LEN_600 | over_explain ≥ 0.7 | Maximaal 600 tekens |
| NO_REPETITION | repetition ≥ 0.6 | Geen herhaalde zinnen |
| EXECUTE_NOW | actievermijdingsloop (2+/3 beurten) | Voer onmiddellijk uit |

## 6. Dynamische ban-ontdekking

### 6.1 LLM post-hoc classifier
Draait dagelijks. Zinnen ≥3 keer geflagd promoveren naar de dynamische banlijst. Kandidaten verlopen na 30 dagen.

### 6.2 Retroactieve patroonminer
Draait elke 15 minuten. Promotiecriteria: ≥5 observaties, ≥60% frictiepercentage, ≥2x lift boven baseline.

### 6.3 Semantische ban-uitbreiding (v4.0)
Wanneer een zin gepromoveerd wordt of een temporele ban gecreëerd, embedt de semantische expansie-engine de zin via text-embedding-3-small en zoekt varianten in het irritatieregister (186 patronen) en het miner-corpus. Varianten boven cosine-similarity 0.82 worden toegevoegd aan de uitgebreide bancache (maximaal 8 per zin). De HARD BAN-lijst bevat deze varianten expliciet — het model ontvangt concrete alternatieve formuleringen om te vermijden.

### 6.4 Semantische n-gram-clustering (v4.0)
De miner's n-gram-kandidaten worden geëmbed en geclusterd op cosine-similarity > 0.80 (minimaal 4-woords n-grammen). Observatietellingen worden geaggregeerd binnen elk cluster, waardoor de effectieve promotiedrempel verlaagd wordt. "ik begrijp je frustratie" (2x) + "ik snap hoe frustrerend" (1x) + "ik kan me voorstellen" (2x) = cluster met 5x totaal, dat de promotiedrempel bereikt die geen individuele variant alleen zou bereiken.

### 6.5 Ban-convergentie
Statische evidence-bans, classifier-gepromoveerde bans, miner-gepromoveerde patronen en hun semantische varianten worden samengevoegd in één HARD BAN-sectie.

## 7. Actievermijdingsloopdetectie

Leest de laatste 8KB van het actieve sessie-transcript JSONL via een gebonden file-descriptorlezing. Sessie-ID opgelost uit `sessions.json` met voorkeur voor gebruiker-specifieke matches. Detectiedrempel: 2+ matchende beurten van de laatste 3. Zelfcorrigerend zodra de agent acties gaat uitvoeren.

## 8. Staatssamenvatting voor memory-core (v4.0)

Na elke achtergrondcyclus schrijft friction-guard `memory/friction-guard-state.md` met: actieve bans (met semantische varianten), classifier-kandidaten, promoteerbare semantische clusters, profielsamenvatting en miner-statistieken. Dit bestand wordt geïndexeerd door memory-core, waardoor de geleerde kennis van friction-guard doorzoekbaar wordt via `memory_search`. Dit sluit de kloof waar geleerde interactiepatronen onzichtbaar waren voor het bredere geheugensysteem.

## 9. Wat de plugin niet doet

- Geen deterministische output-filtering. Constraints zijn instructies, geen regex-filters.
- Geen emotieherkenning. De plugin detecteert frictiepatronen, geen emoties.
- Geen LLM-aanroepen in de real-time pipeline. Classifier draait dagelijks, semantische expansie elke 15 minuten — beiden op de achtergrond.
- Geen semantische matching op gebruikersinput. Pattern-based matching is preciezer voor korte, contextafhankelijke tekst.
- Geen cross-user patroonlekkage. Idiografisch principe gehandhaafd.

---

# Deel II — Technische beschrijving

## 1. Bestandsstructuur

```
~/.openclaw/extensions/friction-guard/
├── index.ts                          → Plugin-entry, hook, orchestratie
└── openclaw.plugin.json              → Plugin-metadata

~/.openclaw/workspace/interaction/
├── friction-policy.ts                → Types, evidence-loader, profielbeheer
├── friction-evidence.json            → Gebruikerskant evidence-register (16 entries)
├── grievance-dictionary.json         → Grievance Dictionary (556 NL / 464 EN stems)
├── grievance-matching.ts             → LIWC-stijl stem-matching
├── agent-irritation-registry.json    → Agentkant patronen (8 categorieën, ~186 zinnen)
├── agent-irritation-matching.ts      → Statische agent-output matcher
├── agent-irritation-classifier.ts    → LLM post-hoc classifier (dagelijks)
├── agent-pattern-miner.ts            → Statistische n-gram miner (elke 15 min)
├── semantic-expansion.py             → Vector-embedding engine (elke 15 min, async)
├── cold-start-priming.ts             → Situation-first protocol (turnCount < 5)
├── context-priming-examples.json     → Contrastieve few-shot voorbeelden
├── incident-log.ts                   → Fragment-logging
├── repetition-detection.ts           → N-gram Jaccard-gelijkenis
└── background-analysis.ts            → Periodieke clusteranalyse

~/.openclaw/workspace/memory/
├── interaction-profiles/{userId}.json
├── incident-logs/{userId}.json
├── turn-history/{userId}.json
├── classifier/classifier-state.json
├── pattern-miner/miner-state.json
├── friction-guard-state.md           → Staatssamenvatting (geïndexeerd door memory-core)
└── semantic/
    ├── embedding-cache.json          → Gecachete frase-embeddings
    ├── ngram-clusters.json           → Semantische n-gram-clusters
    ├── expanded-bans.json            → Ban → variant-mappings
    └── meta.json                     → Modelversie, drempels, laatste verversing
```

## 2. Dataflow per verzoek

```
Gebruikersbericht komt binnen
        │
        ▼
before_prompt_build hook vuurt
        │
        ▼
stripChannelMetadata(text)
        │
        ▼
readProfile(userId)
        │
        ├──► assessFriction(text, profile, lang)
        │        ├──► matchUserInput()            ── evidence-patronen
        │        ├──► computeStructuralMarkers()  ── verkorting, begroetingsverlies
        │        ├──► computeBaselineDeviation()   ── baseline-afwijking
        │        ├──► matchGrievance()             ── Grievance Dictionary
        │        └──► samenvoegen
        │
        ├──► detectUserForcedRepetition()
        ├──► detectActionAvoidanceLoop()   ← leest sessie-transcript
        │
        ├──► buildConstraintPrompt(profile)
        │        ├──► statische bans + getPromotedBans() + getMinedPatterns()
        │        ├──► loadExpandedBanVariants()     ← semantische cache (v4.0)
        │        └──► samenvoegen → HARD BAN + constraint-regels
        │
        ├──► [elke 15 min] runBackgroundAnalysis() + runPatternMining()
        │                   triggerSemanticRefresh()  ← async subprocess (v4.0)
        ├──► [elke 24u]    runClassification()
        │
        ▼
return { prependSystemContext: injection }
```

## 3. Semantische expansie-architectuur (v4.0)

### Embedding engine
`semantic-expansion.py` draait als Python-subprocess, asynchroon aangeroepen via `node:child_process`. Gebruikt OpenAI text-embedding-3-small (1536 dimensies). Embeddings incrementeel gecached. Maximaal 200 embeddings per run, in batches van 100.

### Clustering
Greedy single-pass clustering: cosine-similarity ≥ 0.80. Alleen n-grams met ≥4 woorden en ≥3 observaties. Clusters met ≥5 geaggregeerde observaties en ≥60% frictie zijn promoteerbaar.

### Ban-uitbreiding
Cosine-similarity ≥ 0.82 tegen irritatieregister (186 patronen) en miner-corpus. Maximaal 8 varianten per gebannen zin.

### Waar semantisch zoeken NIET wordt toegepast
- **Gebruikersinput:** semantische similarity kan "ik heb je al gevraagd" (frictie) niet onderscheiden van "ik heb haar al gevraagd" (neutraal).
- **Real-time pipeline:** geen embedding-API-calls in `before_prompt_build`. Alleen gecachete resultaten via synchrone file-I/O.
- **Cross-user:** clusters uit globaal corpus, maar per-user toegepast.

### Risicomitigatie
- Hoge drempels (0.82 voor expansie, 0.80 voor clustering)
- Minimale n-gram lengte (4 woorden voor clustering, 3 voor expansie)
- Embedding-model versioning in cache
- Graceful degradation als cache niet bestaat

## 4. Verwachte startup-log

```
[friction-guard] v4.0.0 — pre-generation constraint injection
[friction-guard] Evidence registry: 16 entries loaded
[friction-guard] Grievance dictionary loaded: 556 NL / 464 EN stems
[friction-guard] Agent irritation registry loaded: 8 categories, 186 patterns
[friction-guard] Cold-start priming loaded: 4 contrastive examples
[friction-guard] Registered on before_prompt_build
```

---

## Referenties

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
Van der Vegt, I., et al. (2021). *Behavior Research Methods, 53*, 2105–2119.
Weiler, S., et al. (2023). *Electronic Markets, 33*, Article 51.
Zheng, Y., et al. (2024). *IT & People, 37*(8), 175–199.

---

*friction-guard v4.0.0 — Naomi Hoogeweij, Rutka en Claude Opus. April 2026.*
