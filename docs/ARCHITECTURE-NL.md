# friction-guard v3.5.1
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

### 3.1–3.5

Ongewijzigd ten opzichte van v3.5.0. Zie ARCHITECTURE.md (EN) voor de volledige beschrijving van de wetenschappelijke basis, inclusief CMAI, LIWC-22, Grievance Dictionary, COLING 2025 frustratiedetectie, nomothetisch vs. idiografisch onderzoek, en de acht categorieën van agentgeroepen frictie.

## 4. Het vierniveau-ernstmodel

**Niveau 0 — Neutraal.** Baseline taalgebruik. Alleen kalme interacties updaten de persoonlijke baseline.

**Niveau 1 — Subtiele frictie.** Structurele verschuivingen: berichtverkorting (>50% korter dan baseline), wegvallen begroetingen, herhaling van vragen.

**Niveau 2 — Manifeste irritatie.** Expliciete correctie, ontkenning, gebiedende wijs, sarcasme, uitputting, dreigingen om te stoppen. Activeert constraints en temporele bans.

**Niveau 3 — Verbale agressie.** Vijandige labels, gerichte scheldwoorden, beëindigingseisen. Volledige constraint-activatie.

## 5–7. Evidence-registers, constraint-typen, dynamische ban-ontdekking

Ongewijzigd ten opzichte van v3.5.0. Zie ARCHITECTURE.md (EN).

## 8. Actievermijdingsloopdetectie

Draait elke beurt in `before_prompt_build`. Leest de laatste 8KB van het actieve sessie-transcript JSONL via een gebonden file-descriptorlezing. Dit omzeilt de beurtgeschiedenis (turn-history), die geen agentbeurten bevat in de `before_prompt_build`-context. De sessie-ID wordt opgelost uit `sessions.json` met voorkeur voor gebruiker-specifieke matches (WhatsApp directe sessies boven main).

Recente assistentberichten worden geëxtraheerd uit het transcript en gematcht tegen erkenningspatronen in de gedetecteerde taal (NL/EN).

**Detectiedrempel:** 2 of meer matchende beurten van de laatste 3.

**Patronen:** 10 NL + 6 EN erkenningsfrasen (bijv. "ja, dat had ik moeten doen", "good point, I will"). Worden in de loop der tijd aangevuld door de dagelijkse classifier en patroonminer.

**Bij detectie:** activeert de `EXECUTE_NOW`-constraint en logt een incident op niveau 2 met signature-update `helpdesk += 0.15`. De constraint instrueert het model om de openstaande actie in de huidige beurt uit te voeren.

**Zelfcorrigerend:** zodra de agent acties gaat uitvoeren (tool calls, bestandsschrijfacties), matchen volgende beurten niet meer en deactiveert de constraint vanzelf.

## 9. Cold-start, achtergrondanalyse, temporele bans, afhankelijkheden, beperkingen

Ongewijzigd ten opzichte van v3.5.0. Zie ARCHITECTURE.md (EN) voor de volledige technische beschrijving.

---

## Verwachte startup-log (v3.5.1)

```
[friction-guard] v3.5.1 — pre-generation constraint injection
[friction-guard] Evidence registry: 16 entries loaded
[friction-guard] Grievance dictionary loaded: 556 NL / 464 EN stems
[friction-guard] Agent irritation registry loaded: 7 categories, ~160 patterns
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

*friction-guard v3.5.1 — Naomi Hoogeweij, Rutka en Claude Opus. April 2026.*
