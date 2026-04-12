# friction-guard v4.2.0
## Functionele en technische beschrijving

---

# Deel I — Functionele beschrijving

## 1. Wat het probleem is

De meeste interactiefouten van AI-agents zijn geen kennisfouten. Een antwoord kan inhoudelijk correct zijn en toch frictie opleveren: te veel uitleg op een kwetsbaar moment, ongevraagd advies wanneer iemand gehoord wil worden, opsommingen waar proza past, of dezelfde zinnen die keer op keer terugkomen. Dit zijn relationele mismatches die, wanneer ze zich herhalen, vertrouwen ondermijnen — ook als het model technisch capabel is.

Het gangbare patroon bij agents is: de gebruiker corrigeert, de agent zegt "sorry, ik doe het beter", en de volgende keer gebeurt precies hetzelfde. De correctie is session-scoped en verdampt bij de volgende interactie. Er is geen leerproces, geen geheugen voor wat niet werkte, en geen mechanisme om herhaling te voorkomen.

## 2. Wat friction-guard doet

friction-guard is een plugin voor OpenClaw die interactiepatronen leert en op basis daarvan het gedrag van de agent aanpast — niet door output achteraf te filteren, maar door constraints mee te geven aan het model vóór generatie.

De plugin doet vijf dingen:

**Meten (gebruikerskant):** Bij elk inkomend bericht analyseert de plugin het taalgebruik van de gebruiker op signalen van frictie — van subtiele verschuivingen (kortere berichten, wegvallen van begroetingen) tot expliciete irritatie (correcties, ontkenningen, scheldwoorden). Elk signaal wordt gewogen tegen een persoonlijke baseline: wat voor deze gebruiker normaal is. Daarnaast biedt de Nederlandse Grievance Dictionary (Van der Vegt et al., 2021) 556 Nederlandse en 464 Engelse gestemde woorden over vier frictie-relevante categorieën.

**Meten (agentkant):** De plugin detecteert ook irritante patronen in de eigen output van de agent via een statisch irritatieregister van ~100 zinnen over zeven evidence-based categorieën. Een LLM post-hoc classifier en een statistische patroonminer ontdekken doorlopend nieuwe irritante patronen uit interactiedata.

**Onthouden:** Frictiesignalen worden opgeslagen als signatures — gewogen scores per categorie (cliché-empathie, ongevraagd advies, helpdesk-toon, overuitleg, opsommingen, herhaling). Deze scores persisteren over sessies en accumuleren geleidelijk. Dynamische bans ontdekt door de classifier en miner worden opgeslagen in een kandidatenbank en gepromoveerd wanneer bevestigd.

**Begrenzen:** Wanneer een signature een drempelwaarde overschrijdt, wordt een constraint geactiveerd. Gebannen zinnen — uit statisch bewijs, LLM-geclassificeerde patronen en door de miner ontdekte n-grammen — worden geïnjecteerd als HARD BAN-sectie vóór alle andere constraints. Het model weet, voordat het begint met genereren, wat het niet moet doen.

**Verouderen:** Constraints die langere tijd niet getriggerd worden verliezen geleidelijk kracht. Temporele bans verlopen na een configureerbare periode. Miner-kandidaten die binnen 30 dagen niet opnieuw geobserveerd worden, worden opgeruimd. Het systeem verstart niet.

## 3. De wetenschappelijke basis

### 3.1 Gebruikerskant: klinische agitatieschalen

De Cohen-Mansfield Agitation Inventory (CMAI; Cohen-Mansfield, 1986) meet agitatie over vijf domeinen. Garriga et al. (2016) beschrijven de escalatiesequentie voorafgaand aan agitatie: vijandige stemming, toenemende onrust, luider spreken, verbale dreigementen. Deze escalatiestructuur vormt de basis voor het vierniveau-ernstmodel.

### 3.2 Gebruikerskant: linguïstische markeranalyse

LIWC-22 (Boyd et al., 2022) biedt gevalideerde woordlijsten voor negatieve emotie en woede. De Grievance Dictionary (Van der Vegt et al., 2021) voegt granulaire categorieën toe — frustratie, wanhoop, grief, haat — met beoordeelde goodness-of-fit scores. De Nederlandse vertaling is direct geïntegreerd: 556 gestemde woorden met LIWC-stijl prefix-matching en voorgecompileerde regexes.

### 3.3 Gebruikerskant: frustratiedetectie in mens-agentinteractie

Hernandez Caralt et al. (COLING 2025) identificeren vier kernmarkers: herhaling van verzoeken, ontkenning, lange onopgeloste gesprekken en ontevredenheid zonder openlijke vijandigheid. Hinrichs & Le (2018) bevestigden dat n-gram tokenisatie met stemming de beste classificatieresultaten opleverde — de basis voor de herhalingsdetectiemodule.

### 3.4 Gebruikerskant: nomothetisch vs. idiografisch

Fisher et al. (2025) maken onderscheid tussen modellen op populatieniveau (between-people) en op individueel niveau (in-person). Idiografische modellen getraind per persoon leveren lagere voorspelfouten, wat bevestigt dat een persoonlijke baseline noodzakelijk is naast markers op populatieniveau.

### 3.5 Agentkant: acht categorieën van agentgeroepen frictie

**Sycophancy** — valse bevestiging, overmatig instemmen. Sharma et al. (2023, Anthropic) toonden pervasief sycofantisch gedrag aan bij vijf assistenten, gedreven door RLHF-beloningssignalen.

**Valse menselijkheid** — performatieve empathie zonder inhoud. Zheng et al. (2024, Emerald) identificeerden dit als apart faalmechanisme. Gebruikers rapporteerden zich verraden te voelen, niet getroost.

**Helpdesk-vulling** — lege responsiviteit. Ozuem et al. (2024) vonden dat generieke antwoorden worden ervaren als een gebrek aan erkenning van de situatie.

**Overuitleg** — paternalistische uitweiding. Bullet-points bij emotionele onderwerpen, ongevraagde pedagogische framing.

**Incorrecte reparatie** — een correctie erkennen zonder te veranderen. Pavone et al. (2023) beschrijven dit als een kritiek falen dat intense negatieve reacties oproept.

**Emotionele incongruentie** — het verkeerde register op het verkeerde moment. Brendel et al. (2023) toonden aan dat mensachtige signalen frustratie versterken bij foutieve interacties. Crolic et al. (2022) bevestigden: warmte werkt averechts bij boze gebruikers.

**Premature oplossing** — springen naar fixes vóór luisteren. Weiler et al. (2023) lieten zien dat oplossingsgerichte berichten scoren op competentie maar niet op warmte.

**Actievermijding** — erkennen wat gedaan moet worden zonder het te doen. De agent zegt herhaaldelijk "ja, dat had ik moeten doen" of "klopt, ik ga dat nu doen" zonder daadwerkelijk een tool aan te roepen, een bestand te schrijven of een commando uit te voeren. Dit is een meerbeurts-patroon: een enkele erkenning is normaal; twee of meer opeenvolgende erkenningen zonder actie wijzen op een loop. Het patroon wordt gedreven door RLHF-beloningssignalen die instemming en uitleg belonen boven uitvoering.

## 4. Het vierniveau-ernstmodel

**Niveau 0 — Neutraal.** Baseline taalgebruik. Alleen kalme interacties updaten de persoonlijke baseline.

**Niveau 1 — Subtiele frictie.** Structurele verschuivingen: berichtverkorting (>50% korter dan baseline), wegvallen begroetingen, herhaling van vragen. Individueel zwak — betekenisvol alleen bij clustering.

**Niveau 2 — Manifeste irritatie.** Expliciete correctie, ontkenning, gebiedende wijs, sarcasme, uitputting, dreigingen om te stoppen. Activeert constraints en temporele bans.

**Niveau 3 — Verbale agressie.** Vijandige labels, gerichte scheldwoorden, beëindigingseisen. Volledige constraint-activatie.

## 5. Evidence-registers

### 5.1 Gebruikerskant (friction-evidence.json)

16 entries over vier niveaus, tweetalig (NL+EN). Drie typen: patroon-gematchte verbale markers, berekende structurele markers en agent-trigger entries.

### 5.2 Grievance Dictionary (grievance-dictionary.json)

590 NL / 475 EN gestemde woorden. Vier categorieën uit Van der Vegt et al. (2021): frustratie, wanhoop, grief, haat. Eén eigen categorie toegevoegd in v4.2.0: ongenoegen — 34 NL / 11 EN stems voor alledaagse ontevredenheid en impliciete kritiek ("meuk", "rommel", "puinhoop", "weer vol", "niks gebeurd", "schiet niet op"). Deze categorie koppelt aan signatuur `confirm_without_deliver` en triggert de constraint `EXECUTE_FIRST`. Severity-mapping: 7–10 rating → 0.3–0.9 frictie-ernst. LIWC-stijl prefix-matching. Early exit per categorie (max 3 matches). CC BY 4.0 gelicenseerd.

### 5.3 Agentkant (agent-irritation-registry.json)

~100 NL/EN zinnen over zeven categorieën (§3.5). Elk gekoppeld aan frictieniveau, ernst, constraints en primaire signatuur. Contextbewust: emotionele incongruentie en premature oplossing vuren alleen wanneer gebruikersfrictie ≥ 1.

## 6. Constraint-typen

| Constraint | Trigger | Wat het model ontvangt |
|---|---|---|
| HARD BAN | Elke actieve gebannen zin | Specifieke zinnenlijst, niet-onderhandelbaar, eerste regel |
| BAN_CLICHE_PHRASES | cliche_empathy ≥ 0.7 | Vermijd performatieve empathie |
| NO_HELPDESK | helpdesk_tone ≥ 0.6 | Geen helpdesk-vulzinnen |
| NO_UNASKED_ADVICE_EMOTIONAL | premature_advice ≥ 0.7 | Geen advies in emotionele context |
| DEFAULT_PROSE | bullet_mismatch ≥ 0.7 | Alleen proza, geen opsommingen tenzij gevraagd |
| MAX_LEN_600 | over_explain ≥ 0.7 | Maximaal 600 tekens |
| NO_REPETITION | repetition ≥ 0.6 | Geen herhaalde zinnen of ideeën |
| EXECUTE_FIRST | confirm_without_deliver ≥ 0.5 | Eerst handelen, dan uitleggen — geen bevestiging zonder uitvoering |
| EXECUTE_NOW | actievermijdingsloop (2+/3 beurten) | Voer onmiddellijk uit, geen uitleg of bevestiging |

## 7. Dynamische ban-ontdekking

### 7.1 LLM post-hoc classifier (agent-irritation-classifier.ts)

Draait dagelijks. Extraheert (agent-turn, geïrriteerde-gebruikersreactie) paren uit incidentlogs voor niveau 2+ events. Stuurt maximaal 10 paren per keer naar het model met een gestructureerde classificatieprompt. Het model identificeert problematische substrings, wijst categorieën en ernst toe. Zinnen die ≥3 keer geflagd worden over aparte incidenten promoveren naar de dynamische banlijst. Kandidaten verlopen na 30 dagen.

### 7.2 Retroactieve patroonminer (agent-pattern-miner.ts)

Draait elke 15 minuten. Extraheert bigrammen, trigrammen en 4-grammen uit agentresponses. Volgt per n-gram: frictietelling (vóór niveau 2+), kalmtetelling (vóór niveau 0), totaal. Promotiecriteria: ≥5 observaties, ≥60% frictiepercentage, ≥2x lift boven baseline. Stop-word filtering (NL+EN). Puur statistisch — geen LLM.

### 7.3 Ban-convergentie

Statische evidence-bans (TTL-gebonden), classifier-gepromoveerde bans en miner-gepromoveerde patronen worden samengevoegd in één HARD BAN-sectie bovenaan de constraint-prompt.

## 8. Cold-start situation-first protocol

Wanneer een gebruikersprofiel nieuw is (minder dan 5 kalme interacties), heeft de plugin geen baseline en geen geleerde constraints. Dit is de fase waarin frame-errors het meest waarschijnlijk zijn: het model kent de persoon nog niet en kan de situatie achter de letterlijke vraag verkeerd lezen.

Tijdens cold start injecteert de plugin een `[SITUATION-FIRST PROTOCOL]` blok in de systeemcontext met contrastieve few-shot voorbeelden. Elk voorbeeld toont een vraag waar de letterlijke lezing afwijkt van de situationele lezing — en het principe dat het oplost. Bijvoorbeeld: "Moet ik lopen of rijden naar de wasstraat?" is geen vraag over hoe de persoon moet reizen, maar over hoe de auto er komt.

Het priming-blok wordt automatisch verwijderd zodra het profiel genoeg kalme interacties heeft om een betekenisvolle baseline te vormen. De voorbeelden worden onderhouden in `context-priming-examples.json` en zijn afgeleid van echte friction-guard incidenten waar de hoofdoorzaak een frame-error was, geen kennisfout.

## 9. Wat de plugin niet doet

- Geen deterministische output-filtering. Constraints zijn instructies aan het model, geen regex-filters.
- Geen emotieherkenning. De plugin detecteert frictiepatronen, geen emoties.
- Geen LLM-aanroepen in de real-time pipeline. De classifier draait offline (dagelijks).

---

# Deel II — Technische beschrijving

## 1. Installatie

### Via OpenClaw CLI

```bash
openclaw plugins install openclaw-friction-guard
openclaw plugins enable friction-guard
```

### Handmatige installatie

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

# Fix imports voor server-padindeling
sed -i 's|from "./|from "../../workspace/interaction/|g' \
  ~/.openclaw/extensions/friction-guard/index.ts

# Plugin-manifest aanmaken
cat > ~/.openclaw/extensions/friction-guard/openclaw.plugin.json << 'EOF'
{
  "name": "friction-guard",
  "id": "friction-guard",
  "version": "3.3.0",
  "description": "Evidence-based frictiedetectie en pre-generatie constraint-handhaving voor interactiekwaliteit.",
  "entry": "index.ts",
  "configSchema": {},
  "activation": { "event": "agent.start" }
}
EOF

openclaw plugins enable friction-guard
systemctl --user restart openclaw-gateway
```

### Verificatie

```bash
openclaw plugins list | grep friction
```

Verwachte startup-log:
```
[friction-guard] v3.4.0 — pre-generation constraint injection
[friction-guard] Evidence registry: 16 entries loaded
[friction-guard] Grievance dictionary loaded: 556 NL / 464 EN stems
[friction-guard] Agent irritation registry loaded: 7 categories, ~160 patterns
[friction-guard] Cold-start priming loaded: 4 contrastive examples
[friction-guard] Registered on before_prompt_build
```

## 2. Bestandsstructuur

```
~/.openclaw/extensions/friction-guard/
├── index.ts                          → Plugin-entry, hook, orchestratie
└── openclaw.plugin.json              → Plugin-metadata

~/.openclaw/workspace/interaction/
├── friction-policy.ts                → Types, evidence-loader, profielbeheer
├── friction-evidence.json            → Gebruikerskant evidence-register (16 entries)
├── grievance-dictionary.json         → Grievance Dictionary (556 NL / 464 EN stems)
├── grievance-matching.ts             → LIWC-stijl stem-matching
├── agent-irritation-registry.json    → Agentkant patronen (7 categorieën, ~100 zinnen)
├── agent-irritation-matching.ts      → Statische agent-output matcher
├── agent-irritation-classifier.ts    → LLM post-hoc classifier (dagelijks)
├── agent-pattern-miner.ts            → Statistische n-gram miner (elke 15 min)
├── cold-start-priming.ts             → Situation-first protocol (turnCount < 5)
├── context-priming-examples.json     → Contrastieve few-shot voorbeelden voor cold start
├── incident-log.ts                   → Fragment-logging
├── repetition-detection.ts           → N-gram Jaccard-gelijkenis
└── background-analysis.ts            → Periodieke clusteranalyse

~/.openclaw/workspace/memory/
├── interaction-profiles/{userId}.json
├── incident-logs/{userId}.json
├── turn-history/{userId}.json
├── classifier/classifier-state.json
└── pattern-miner/miner-state.json
```

## 3. Dataflow per verzoek

```
Gebruikersbericht komt binnen
        │
        ▼
before_prompt_build hook vuurt
        │
        ▼
stripChannelMetadata(text)        ← verwijder WhatsApp/kanaal-envelope,
        │                            media-markers, tool-instructies
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
        │        ├──► matchUserInput()            ── evidence-patronen (NL+EN)
        │        ├──► computeStructuralMarkers()  ── verkorting, begroetingsverlies
        │        ├──► computeBaselineDeviation()   ── persoonlijke baseline-afwijking
        │        ├──► matchGrievance()             ── Grievance Dictionary stems
        │        └──► samenvoegen: niveau, entries, constraints, signature-updates
        │
        ├──► detectUserForcedRepetition()  ← overgeslagen als niveau ≥ 2
        │
        ├──► signature-updates toepassen
        ├──► constraints activeren
        ├──► logFragment() als niveau > 0
        ├──► addBan() voor agent-patronen bij niveau ≥ 2
        ├──► updateBaseline() alleen bij niveau 0
        ├──► inferConstraints(profile)
        ├──► writeProfile()
        │
        ├──► buildConstraintPrompt(profile)
        │        ├──► statische bans (TTL-gebonden)
        │        ├──► getPromotedBans()     ← classifier
        │        ├──► getMinedPatterns()     ← miner
        │        └──► samenvoegen → HARD BAN (eerste regel) + constraint-regels
        │
        ├──► buildColdStartPrompt(turnCount) ← situation-first priming als turnCount < 5
        │
        ├──► buildFrictionNote(level)
        │
        ├──► [elke 15 min] runBackgroundAnalysis() + runPatternMining()
        ├──► [elke 24u]    runClassification() via api.complete
        │
        ▼
return { prependSystemContext: coldStartBlock + constraintPrompt + frictionNote }
```

## 4. Input-sanitisatie

`stripChannelMetadata()` verwijdert:
- `Conversation info (untrusted metadata):` + omheinde JSON-blokken
- `Sender (untrusted metadata):` + omheinde JSON-blokken
- Media-markers: `[media attached: ...]`, `[audio message]`, etc.
- Tool-instructieblokken: "To send an image back...", systeeminstructies
- Cron/heartbeat wrapper-regels
- Bootstrap truncation warnings (`[Bootstrap truncation warning]...`) — systeemcontext die OpenClaw injecteert wanneer workspace-bestanden worden afgekapt bij bootstrap. Zonder stripping gaat deze tekst door de Grievance Dictionary en veroorzaakt vals-positieve frictiescores. Toegevoegd in v4.2.0.
- `System (untrusted):` exec-resultaatblokken — tool-executie-output die aan gebruikersberichten wordt toegevoegd
- Pre-compaction memory flush-blokken — memory-core systeeminstructies
- Inter-session message-headers — agent-naar-agent communicatie-enveloppen
- Queued-messages wrappers — systeemenvelop voor gebatchte berichten

## 5. Evidence-registerschema

```typescript
interface EvidenceEntry {
  id: string;                    // "L2-001", "AGENT-002"
  level: 0 | 1 | 2 | 3;
  severity: number;              // 0..1
  type: "structural" | "verbal" | "agent_trigger";
  marker: string;
  patterns?: Record<string, string[]>;  // taal → zinnen
  detection: "pattern" | "computed" | "pattern_plus_context" | "semantic_similarity";
  contexts: ("emotional" | "technical" | "neutral")[];
  suggestedConstraints: Constraint[];
}
```

## 6. Profielschema

```typescript
interface UserProfile {
  userId: string;
  updatedAt: string;
  signatures: Record<Signature, number>;  // 6 categorieën, elk 0..1
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
  recentTurnLengths: number[];  // schuifvenster, max 10
}
```

### Signature-dynamiek

Stijging: N1 +0,03, N2 +0,08, N3 +0,15 per gematchte entry.
Daling: constraint-verval (48u niet getriggerd → -0,02/cyclus), achtergrond de-escalatie (geïsoleerd N1 na 2u → -0,01).

### Baseline-leren

Uitsluitend bijgewerkt uit niveau-0 (kalme) interacties. Exponentieel afnemend gewicht: `alpha = min(0.1, 1/(turnCount+1))`.

## 7. Herhalingsdetectie

Gewogen Jaccard: `trigrammen × 0,5 + bigrammen × 0,3 + woorden × 0,2`

**Gebruiker geforceerde herhaling:** Drempel 0,65, minimaal 3 gedeelde trigrammen. Overgeslagen bij niveau ≥ 2.
**Agent zelf-herhaling:** Drempel 0,55. Alleen turngeschiedenis (geen output-hook).
**Opslag:** 30-turns schuifvenster per gebruiker, tekst afgekapt op 500 tekens.

## 8. Actievermijdingsloopdetectie

Draait elke beurt in `before_prompt_build`. Leest de laatste 3 agentbeurten uit de beurtgeschiedenis (via `readHistory` uit `repetition-detection.ts`). Matcht elke beurt tegen erkenningspatronen in de gedetecteerde taal (NL/EN).

**Detectiedrempel:** 2 of meer matchende beurten van de laatste 3.

**Patronen:** 14 NL + 12 EN erkenningsfrasen (bijv. "ja, dat had ik moeten doen", "good point, I will"). Worden in de loop der tijd aangevuld door de dagelijkse classifier en patroonminer.

**Bij detectie:** activeert de `EXECUTE_NOW`-constraint en logt een incident op niveau 2 met signature-update `helpdesk += 0.15`. De constraint instrueert het model om de openstaande actie in de huidige beurt uit te voeren.

**Zelfcorrigerend:** zodra de agent acties gaat uitvoeren (tool calls, bestandsschrijfacties), matchen volgende beurten niet meer en deactiveert de constraint vanzelf.

## 9. Achtergrondanalyse

Draait elke 15 minuten. Drie operaties:
- **Temporele clustering:** fragmenten binnen 10 min gegroepeerd, effectief niveau per cluster.
- **Escalatie:** 3+ niveau-1 in één cluster → effectief niveau 2.
- **De-escalatie:** geïsoleerd niveau-1 zonder herhaling binnen 2u → signature-verval.

## 10. Temporeel ban-mechanisme

Bij niveau 2+ worden agent-trigger zinnen gebanned met TTL: `BASE_TTL × (0,5 + severity)`. BASE_TTL = 2 uur. Verlopen bans worden opgeruimd aan het begin van elke cyclus.

## 11. Afhankelijkheden

Geen. Alleen Node.js standaardbibliotheek: `node:fs`, `node:path`.

## 12. Zelfinspectie-tooling

`scripts/friction_guard_inspect.py` biedt on-demand inspectie van de friction-guard state. Het primaire commando is `summary`, dat een kant-en-klare samenvatting in het Nederlands uitvoert — bedoeld om door de agent door te geven zonder verdere interpretatie.

Commando's:
- `summary` — huidig niveau, actieve constraints in gewoon Nederlands, distributie laatste 10 berichten, laatste frictie-event met context. Standaardcommando voor rapportage aan de gebruiker.
- `status` — gecombineerd profiel en laatste 5 incidents (ruwe data).
- `incidents --last N --min-level L` — gefilterd incidentlog met distributie en markerfrequentie.
- `profile` — volledige JSON-profieldump.
- `explain` — architectuurnotitie over het verschil tussen friction-guard en agent_strain_policy.

Ontwerpprincipe: de `summary`-output vereist geen interpretatie door de agent. Dit voorkomt dat de agent data verkeerd presenteert (bijv. totaaldistributie over alle fragments verwarren met een recent venster). De agent geeft de output door, niet samenvatten.

## 13. Bekende beperkingen

| Beperking | Status |
|---|---|
| Geen deterministische output-filtering | Wacht op OpenClaw `message:sending` hook (#13004) |
| LLM-classifier vereist api.complete | No-op als niet beschikbaar |
| Patroonminer heeft data nodig | Betekenisvol na ~50+ interacties |
| Sycophancy-detectie alleen patroongebaseerd | Classifier + miner ontdekken nieuwe patronen |

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

*friction-guard v3.5.0 — Naomi Hoogeweij, Rutka en Claude Opus. Maart 2026.*
