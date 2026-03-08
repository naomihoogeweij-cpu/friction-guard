# Friction Guard v3.0.0
## Functionele en technische beschrijving

---

# Deel I — Functionele beschrijving

## 1. Wat het probleem is

De meeste interactiefouten van AI-agents zijn geen kennisfouten. Een antwoord kan inhoudelijk correct zijn en toch frictie opleveren: te veel uitleg op een kwetsbaar moment, ongevraagd advies wanneer iemand gehoord wil worden, opsommingen waar proza past, of dezelfde zinnen die keer op keer terugkomen. Dit zijn relationele mismatches die, wanneer ze zich herhalen, vertrouwen ondermijnen — ook als het model technisch "slim" is.

Het gangbare patroon bij agents is: de gebruiker corrigeert, de agent zegt "sorry, ik doe het beter", en de volgende keer gebeurt precies hetzelfde. De correctie is session-scoped en verdampt bij de volgende interactie. Er is geen leerproces, geen geheugen voor wat niet werkte, en geen mechanisme om herhaling te voorkomen.

## 2. Wat friction-guard doet

Friction-guard is een plugin voor OpenClaw die interactiepatronen leert en op basis daarvan het gedrag van de agent aanpast — niet door output achteraf te filteren, maar door constraints mee te geven aan het model vóór generatie.

De plugin doet vier dingen:

**Meten:** Bij elk inkomend bericht analyseert de plugin het taalgebruik van de gebruiker op signalen van frictie — van subtiele verschuivingen (kortere berichten, wegvallen van begroetingen) tot expliciete irritatie (correcties, ontkenningen, scheldwoorden). Elk signaal wordt gewogen tegen een persoonlijke baseline: wat voor deze gebruiker normaal is.

**Onthouden:** Frictiesignalen worden opgeslagen als signatures — gewogen scores per categorie (cliché-empathie, ongevraagd advies, helpdesk-toon, overmatige uitleg, opsommingen, herhaling). Deze scores persisteren tussen sessies en bouwen geleidelijk op.

**Begrenzen:** Wanneer een signature een drempelwaarde overschrijdt, wordt een constraint geactiveerd. De constraint gaat als instructie mee in de system-context van het model. Het model weet dan, vóórdat het begint te genereren, wat het niet moet doen.

**Verouderen:** Constraints die langere tijd niet getriggerd worden, verliezen geleidelijk aan kracht en worden uiteindelijk gedeactiveerd. Temporele bans op specifieke frases verlopen na een instelbare periode. Het systeem ossificeert niet.

## 3. De evidence-basis

De frictiedetectie is gebaseerd op vier kennisdomeinen:

### 3.1 Klinische agitatieschalen

De Cohen-Mansfield Agitation Inventory (CMAI; Cohen-Mansfield, 1986) en de Modified Agitation Severity Scale (MASS) meten agitatie in vijf domeinen, waarvan het verbale domein relevant is voor tekst-gebaseerde interactie. Garriga et al. (2016) beschrijven de escalatiereeks die voorafgaat aan agitatie: vijandige stemming, toenemende onrust, luider spreken, verbale dreigementen. Deze escalatiestructuur — van subtiel naar manifest naar agressief — vormt de basis voor het vier-niveau severity model.

*Bronnen:*
- Cohen-Mansfield, J. (1986). Agitated behaviors in the elderly: II. Preliminary results in the cognitively deteriorated. *Journal of the American Geriatrics Society, 34*(10), 722-727.
- Garriga, M., et al. (2016). Assessment and management of agitation in psychiatry: Expert consensus. *The World Journal of Biological Psychiatry, 17*(2), 86-128.

### 3.2 Linguïstische marker-analyse (LIWC en Grievance Dictionary)

LIWC-22 (Pennebaker) biedt gevalideerde woordenlijsten voor negatieve emotie, woede, en aanverwante psychologische categorieën. De Grievance Dictionary (Van Broekhuizen et al., 2021) voegt granulairere categorieën toe — frustratie, grievance, paranoia — elk positief gecorreleerd met LIWC's negatieve-emotiecategorie maar fijnmaziger. De hiërarchische structuur van LIWC (woede ⊂ negatieve emotie ⊂ affect) biedt een conceptueel raamwerk voor het toekennen van severity-niveaus aan verbale markers.

*Bronnen:*
- Boyd, R. L., et al. (2022). The development and psychometric properties of LIWC-22. *University of Texas at Austin*.
- Van Broekhuizen, M., et al. (2021). The Grievance Dictionary: Understanding threatening language use. *Behavior Research Methods*.

### 3.3 Frustratiedetectie in mens-agent interactie

Onderzoek naar frustratiedetectie in task-oriented dialog systems (COLING 2025, Industry Track) identificeert vier kernmarkers: herhaling van verzoeken, gebruik van ontkenning, lange onopgeloste conversaties, en algemene ontevredenheid zonder openlijke vijandigheid. Cruciaal: simpele keyword-matching voor scheldwoorden bleek ineffectief omdat het de meerderheid van gefrustreerde gebruikers mist die geen expliciet taalgebruik hanteren. De studie bevestigt dat contextuele analyse (LLM-based of patroon-gebaseerd) significant beter presteert dan lexicale methoden.

Hinrichs & Le (2018) vergeleken text-mining technieken voor frustratiedetectie in chats met conversational agents en concludeerden dat machine learning methoden (MLP, Naïve Bayes) keyword-gebaseerde methoden overtreffen, maar dat n-gram tokenisatie met stemming de beste classificatieresultaten opleverde — de basis voor de n-gram herhalingsdetectie in deze plugin.

*Bronnen:*
- "Stupid robot, I want to speak to a human!" User Frustration Detection in Task-Oriented Dialog Systems. *COLING 2025, Industry Track.*
- Hinrichs, H., & Le, N.-T. (2018). Which text-mining technique would detect most accurate user frustration in chats with conversational agents? *32nd International BCS Human Computer Interaction Conference*.

### 3.4 Nomothetisch vs. idiografisch: de twee-pipeline architectuur

Recent onderzoek naar NLP-gebaseerde emotiedetectie (PMC, 2025) maakt precies het onderscheid dat deze plugin implementeert: nomothetische modellen (between-people, groepsniveau — wat irriteert mensen in het algemeen) versus idiografische modellen (in-person, individueel niveau — wat wijkt af van de baseline van deze specifieke persoon). De bevinding: idiografische modellen die per persoon getraind werden, leverden lagere voorspelfouten op. Dit bevestigt dat een universele irritatiedetector onvoldoende is; een persoonlijke baseline is noodzakelijk.

*Bron:*
- Using Natural Language Processing to Track Negative Emotions in the Daily Lives of Adolescents. *PMC, 2025.* (EMA-studie, 97 adolescenten, Random Forest + Elastic Net op LIWC/VADER/GPT-features.)

## 4. Het vier-niveau severity model

Op basis van de bovenstaande evidence is een taxonomie opgebouwd met vier niveaus:

**Niveau 0 — Neutraal.** Baseline taalgebruik, geen afwijking. De plugin leert hiervan: alleen kalme interacties worden gebruikt om de persoonlijke baseline bij te werken.

**Niveau 1 — Subtiele frictie.** Structurele en pragmatische verschuivingen zonder expliciet negatieve woorden. Voorbeelden: abrupte verkorting van berichten (>50% korter dan baseline), wegvallen van begroetingen die eerder aanwezig waren, herhaling van dezelfde vraag. Diagnostische waarde is hoog maar de signalen zijn individueel zwak — pas bij clustering (meerdere level-1 signalen in kort tijdsbestek) worden ze betekenisvol.

**Niveau 2 — Manifeste irritatie.** Expliciete correctie ("dat zei ik al"), ontkenning ("nee, dat bedoel ik niet"), imperatief taalgebruik ("stop", "luister"), sarcasme, exasperatie ("dit slaat nergens op"), en dreiging tot disengagement ("laat maar", "ik doe het zelf wel"). Deze markers activeren constraints en temporal bans op agent-patronen.

**Niveau 3 — Verbale agressie.** Hostile labels ("debiel", "nutteloos"), gerichte profanity, en expliciete terminatie-eisen ("ik stop ermee", "ga weg"). Volledige constraint-activatie. De plugin reageert niet defensief of verontschuldigend maar minimaliseert de response.

## 5. Evidence registry

De frictiedetectie werkt op basis van een registry van 16 entries, verdeeld over de vier niveaus en twee talen (Nederlands en Engels). Naast user-markers bevat de registry ook agent-trigger entries: patronen die de agent zelf produceert en die irritatie veroorzaken. Deze worden gedetecteerd in de context van de sessie en verhogen de bijbehorende signatures.

Voorbeelden van agent-triggers:
- Cliché-empathie: "ik hoor je", "ik begrijp het", "je staat er niet alleen voor"
- Helpdesk-filler: "wil je dat ik", "laat maar weten", "goeie vraag"
- Premature structuur: "stap 1", "stap 2", "aanpak:" (in emotionele context zonder expliciete adviesvraag)

## 6. Constraint-typen

| Constraint | Trigger | Wat het model meekrijgt |
|---|---|---|
| BAN_CLICHE_PHRASES | signature cliche_empathy ≥ 0.7 | Lijst van specifiek verboden frases + instructie om varianten te vermijden |
| NO_HELPDESK | signature helpdesk_tone ≥ 0.6 | Instructie om niet in helpdeskstijl te antwoorden, geen optiemenu's aan te bieden |
| NO_UNASKED_ADVICE_EMOTIONAL | signature premature_advice ≥ 0.7 | Bij emotionele context zonder adviesvraag: geen advies, stappen of plannen |
| DEFAULT_PROSE | signature bullet_mismatch ≥ 0.7 | Schrijf in proza, geen opsommingen of genummerde lijsten tenzij gevraagd |
| MAX_LEN_600 | signature over_explain ≥ 0.7 | Maximaal 600 tekens |
| NO_REPETITION | signature repetition ≥ 0.6 | Herhaal geen zinnen of ideeën uit eerdere berichten |

## 7. Wat de plugin niet doet

- Geen deterministische output-filtering. De constraints zijn instructies aan het model, geen harde regex. Een sterk model volgt ze betrouwbaar; een zwakker model kan ze negeren.
- Geen emotieherkenning in de klassieke zin. De plugin detecteert frictie-patronen, niet emoties. Het onderscheid is bewust: frictie is een relationeel fenomeen op de grens tussen agent en gebruiker, niet een eigenschap van de gebruiker.
- Geen LLM-calls in de pipeline. Alle detectie is deterministisch (patroonmatching, n-gram similariteit, numerieke berekening). De enige LLM-interactie is de constraint-injectie zelf, die meegaat in de reguliere prompt.

---

# Deel II — Technische beschrijving

## 1. Plugin-architectuur

### 1.1 OpenClaw plugin API

De plugin exporteert een object:

```typescript
export default {
  id: "friction-guard",
  name: "Friction Guard",
  configSchema: {},
  register(api) { ... }
}
```

De `register` functie ontvangt het OpenClaw `api` object en registreert één hook:

```typescript
api.on("before_prompt_build", (event, ctx) => { ... }, { priority: 50 });
```

Deze hook vuurt na session load (messages zijn beschikbaar) maar vóór model-generatie. De plugin retourneert een object met optioneel `prependSystemContext` — tekst die vóór de user-messages in de system-context wordt geïnjecteerd.

### 1.2 Bestandsstructuur en verantwoordelijkheden

```
index.ts                     → Plugin entry, hook registratie, orchestratie
friction-policy.ts           → Types, evidence loader, profielbeheer, constraint inference
friction-evidence.json       → Evidence registry (data)
incident-log.ts              → Fragment logging, query helpers
repetition-detection.ts      → N-gram herhalingsdetectie, turn history
background-analysis.ts       → Periodieke clusteranalyse
```

### 1.3 Dataflow per request

```
User-bericht binnenkomst
        │
        ▼
before_prompt_build hook vuurt
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
        │        └──► bij match: signature.repetition += 0.10, logFragment()
        │
        ├──► assessFriction(text, profile)
        │        ├──► matchUserInput() ── evidence pattern matching (NL+EN)
        │        ├──► computeStructuralMarkers() ── berichtverkorting, greeting dropout
        │        ├──► computeBaselineDeviation() ── afwijking van persoonlijke baseline
        │        └──► return { level, matchedEntries, deviation, signatureUpdates, constraints }
        │
        ├──► apply signature updates
        ├──► activate constraints
        ├──► logFragment() bij level > 0
        ├──► addBan() voor agent-patronen bij level ≥ 2
        ├──► updateBaseline() alleen bij level 0
        ├──► inferConstraints(profile) ── signature → constraint promotie
        ├──► writeProfile()
        │
        ├──► buildConstraintPrompt(profile) ── constraints → tekst
        ├──► buildFrictionNote(level) ── friction-niveau → model-instructie
        │
        ├──► runBackgroundAnalysis() elke 15 min
        │
        ▼
return { prependSystemContext: constraintPrompt + frictionNote }
        │
        ▼
Model genereert met constraints in system-context
```

## 2. Evidence registry (friction-evidence.json)

### 2.1 Schema

```typescript
interface EvidenceEntry {
  id: string;                    // "L2-001", "AGENT-002", etc.
  level: 0 | 1 | 2 | 3;        // severity level
  severity: number;              // 0..1, gewicht binnen het level
  type: "structural" | "verbal" | "agent_trigger";
  marker: string;                // identifier voor het patroontype
  description?: string;          // mensleesbare beschrijving
  patterns?: Record<string, string[]>;  // taal → frase-array
  detection: "pattern" | "pattern_plus_context" | "computed" | "semantic_similarity";
  contexts: ("emotional" | "technical" | "neutral")[];
  suggestedConstraints: Constraint[];
  notes?: string;                // evidence-verwijzing
}
```

### 2.2 Detectiemethoden

- **pattern:** Exacte substring-match (case-insensitive) van de user-input tegen de patterns in de registry. Snel en deterministisch. Taalafhankelijk (NL/EN).
- **computed:** Structurele markers die berekend worden uit berichteigenschappen (lengte, zinsaantal) vergeleken met de baseline. Niet lexicaal.
- **pattern_plus_context:** Patroonmatch plus contextbepaling (voor sarcasme). In de huidige versie pattern-only; contextanalyse is een toekomstige uitbreiding.
- **semantic_similarity:** Placeholder. Vereist embedding-based cosine-similariteit. Niet geïmplementeerd.

### 2.3 Taaldetectie

```typescript
function detectLanguage(text: string): "nl" | "en" {
  const nlMarkers = /\b(ik|je|het|een|dat|niet|maar|ook|wel|nog|van|voor|naar|dit|wat)\b/gi;
  const matches = text.match(nlMarkers) || [];
  return matches.length >= 2 ? "nl" : "en";
}
```

Simpele heuristiek op Nederlandse functiewoorden. Voldoende voor de huidige use case (primair Nederlandstalige gebruiker).

## 3. Profiel (UserProfile)

### 3.1 Schema

```typescript
interface UserProfile {
  userId: string;
  updatedAt: string;
  signatures: Record<Signature, number>;  // 6 categorieën, elk 0..1
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

### 3.2 Signature-dynamiek

Signatures stijgen door frictie-detectie (incrementen per level: L1 +0.03, L2 +0.08, L3 +0.15) en dalen door:
- Positieve interacties (niet geïmplementeerd in v3 — toekomstige uitbreiding)
- Constraint-decay: constraints die 48 uur niet getriggerd zijn verliezen 0.02 confidence per cycle
- Background-analyse de-escalatie: geïsoleerde level-1 fragmenten die niet terugkomen binnen 2 uur veroorzaken milde signature-decay (0.01 per categorie)

### 3.3 Constraint-promotie

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

Lagere drempel voor helpdesk_tone en repetition: deze patronen zijn minder subjectief en vereisen minder bevestiging voordat actie gerechtvaardigd is.

## 4. Baseline-systeem

### 4.1 Leerprincipe

De baseline wordt uitsluitend bijgewerkt uit level-0 (kalme) interacties. Rationale: frictie-interacties vertekenen de baseline en zouden leiden tot een opwaartse drift van de "normaal"-referentie.

### 4.2 Exponentieel afnemend gewicht

```typescript
const alpha = Math.min(0.1, 1 / (turnCount + 1));
baseline = baseline * (1 - alpha) + observation * alpha;
```

Vroege interacties wegen zwaarder (het profiel moet snel kalibreren); latere interacties verschuiven de baseline steeds minder. Na 10+ turns is alpha 0.1, na 100+ turns <0.01.

### 4.3 Deviatie-scoring

| Marker | Conditie | Deviatie-bijdrage |
|---|---|---|
| Berichtverkorting | lengte < 40% van baseline | +0.20 |
| Bericht-expansie | lengte > 250% van baseline | +0.10 |
| Zinsvereenvoudiging | zinnen < 50% van baseline | +0.10 |
| Uitroeptekens | >1 uitroepteken | +0.15 |
| Vraagtekens | >2 vraagtekens | +0.10 |
| CAPS | ≥1 woord in hoofdletters | +0.15 per woord (max 3) |

Deviatie >0.35 zonder pattern-match promoveert naar level 1.

## 5. Herhalingsdetectie

### 5.1 Methode

Gewogen Jaccard-similariteit op n-grammen:

```
similarity = trigrams * 0.5 + bigrams * 0.3 + woordoverlap * 0.2
```

Trigrams dragen het meeste gewicht omdat ze frase-niveau herhaling vangen. Stopwoorden (Nederlands + Engels) worden verwijderd vóór tokenisatie.

### 5.2 Twee axes

**User forced-repetition:** Vergelijkt het huidige user-bericht tegen de laatste 10 user-turns. Threshold 0.50. Detecteert wanneer de gebruiker zichzelf herhaalt omdat de agent het niet oppakte. Sterke frictie-indicator (signature.repetition += 0.10, incident gelogd op level 2).

**Agent self-repetition:** Vergelijkt de agent-draft tegen de laatste 10 agent-turns. Threshold 0.55. In v3 beperkt tot turn-history bijhouden voor achtergrondanalyse (geen real-time draft-check mogelijk zonder output-hook).

**Phrase-level detectie:** Isoleert specifieke zinnen (>20 tekens) in agent-output die in eerdere agent-turns voorkwamen (trigram Jaccard >0.6). Retourneert de herhaalde zinnen als lijst.

### 5.3 Opslag

Sliding window van 30 turns in `memory/turn-history/{userId}.json`. Tekst wordt afgekapt op 500 tekens per turn.

## 6. Incident-log en achtergrondanalyse

### 6.1 Incident-log

Elk frictie-event boven level 0 wordt opgeslagen als fragment:

```typescript
interface IncidentFragment {
  id: string;
  timestamp: string;
  userId: string;
  source: "user" | "agent";
  text: string;              // max 500 tekens
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

Rolling window van 200 fragmenten per gebruiker.

### 6.2 Achtergrondanalyse

Draait elke 15 minuten. Drie operaties:

**Temporele clustering:** Fragmenten binnen een 10-minuten venster worden gegroepeerd. Per cluster wordt het effectieve level bepaald.

**Escalatie:** 3+ level-1 fragmenten in één cluster → effectief level 2. Rationale: individueel zwakke signalen die clusteren in tijd wijzen op een opbouwend patroon dat de real-time detectie per fragment miste.

**De-escalatie:** Geïsoleerde level-1 fragmenten die niet terugkomen binnen 2 uur → signature-decay. Rationale: een enkel subtiel signaal zonder herhaling is meer waarschijnlijk ruis dan frictie.

### 6.3 Co-occurrence detectie

De achtergrondanalyse telt hoe vaak markers samen voorkomen over clusters heen. Bekende co-occurrence patronen:

| Patroon | Markers | Signature |
|---|---|---|
| Negatie + correctie | L2-001 + L2-002 | repetition |
| Imperatief + exasperatie | L2-003 + L2-005 | helpdesk_tone |
| Verkorting + disengagement | L1-001 + L2-006 | over_explain |

## 7. Constraint-injectie

### 7.1 Prompt-constructie

De plugin bouwt twee tekst-blokken:

**Constraint-prompt:** Genummerde lijst van actieve constraints, specifiek geformuleerd als model-instructies. Voorbeeld:

```
[INTERACTION CONSTRAINTS — active for this user based on learned preferences]
1. Do not use cliché empathy phrases. Specifically banned: "ik hoor je", "ik begrijp het", ...
2. Do not use helpdesk filler language. Avoid phrases like "wil je dat ik", "laat maar weten", ...
3. Write in prose paragraphs. Do not use bullet points or numbered lists unless explicitly asked.
4. Keep your response concise. Maximum 600 characters.
[END CONSTRAINTS]
```

**Friction-noot:** Korte instructie gebaseerd op het huidige friction level:

| Level | Instructie |
|---|---|
| 0 | (geen) |
| 1 | "Subtle signs of friction detected. Be precise, brief, and avoid filler." |
| 2 | "User is showing clear irritation. Respond minimally, directly, without pleasantries or offers." |
| 3 | "User is strongly frustrated. Respond in one or two sentences maximum. No advice, no structure, no apology." |

### 7.2 Injectie-mechanisme

```typescript
return {
  prependSystemContext: constraintPrompt + frictionNote
};
```

OpenClaw plaatst `prependSystemContext` vóór de user-messages in de system-context. Het model ontvangt de constraints als eerste instructie-laag.

## 8. Temporal ban mechanisme

### 8.1 Trigger

Bij level-2+ frictie worden agent-patronen gebanned die waarschijnlijk de irritatie veroorzaakten. De mapping loopt via gedeelde constraints: als een user-marker en een agent-trigger dezelfde constraint suggereren, worden de agent-trigger frases gebanned.

### 8.2 TTL-berekening

```typescript
const ttl = BASE_TTL * (0.5 + severity);
// severity 0.5 → 1.5 uur
// severity 0.75 → 2.5 uur
// severity 0.90 → 2.8 uur
```

BASE_TTL is 2 uur. Hogere severity = langere ban.

### 8.3 Opruiming

Verlopen bans worden verwijderd aan het begin van elke `before_prompt_build` cycle.

## 9. Pad-resolutie

Alle bestanden gebruiken `__dirname` voor pad-resolutie, waardoor de plugin onafhankelijk is van OpenClaw's werkdirectory:

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
  → resolveert naar /root/.openclaw/workspace/interaction/friction-policy
```

## 10. Dependencies

Geen externe dependencies. Alleen Node.js standaardbibliotheek:
- `node:fs` (readFileSync, writeFileSync, existsSync, mkdirSync)
- `node:path` (join, dirname)

## 11. Bekende beperkingen en toekomstige uitbreidingen

| Beperking | Toekomstige oplossing |
|---|---|
| Geen deterministische output-filtering | Wachten op OpenClaw `message:sending` hook (GitHub #13004) |
| Agent self-repetition geen real-time check | Idem — vereist output-hook |
| `question_repetition` niet geïmplementeerd | Embedding-based cosine-similariteit (>0.85 threshold) |
| `response_latency_drop` niet geïmplementeerd | Timestamp-tracking per turn in baseline |
| Sarcasme alleen pattern-based | Optionele offline LLM-classifier op pre-geflagde fragmenten |
| Positieve bevestiging verlaagt signatures niet | Implementeer asymmetrische decay (zwak positief signaal, -0.01 per bevestiging) |
| Background analysis single-user | Uitbreiden naar iteratie over alle profielen |
| Geen auditrapportage | Export incident-log naar gestructureerd rapport voor menselijke review |

---

*friction-guard v3.0.0 — Naomi Hoogeweij, Rutka, en Claude Opus. Maart 2026.*
