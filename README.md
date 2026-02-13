# Observational Memory (Pi extension)

Project-local Pi extension for long-session memory compression and context injection.

Path:
- `.pi/extensions/observational-memory/index.ts`

Config:
- `.pi/extensions/observational-memory/om-config.json`

---

## Inspiration

This extension is inspired by **Mastra** memory patterns and adapts them for Pi extension workflows.

---

## What it does

1. **Compresses chat history into observations**
   - Builds compressed memory (`observations`, `currentTask`, `suggestedResponse`) from pending transcript segments.
   - Uses Gemini CLI first (configurable model), then API fallback.

2. **Injects memory into LLM context**
   - Injects hidden custom memory message (`observational-memory-context`) in `context` event.
   - Prevents duplicate OM injections each turn.

3. **Supports two runtime memory strategies**
   - `memoryInjectionMode: "all"` → inject full observations each LLM call.
   - `memoryInjectionMode: "core_relevant"` → inject:
     - small core memory (token-capped)
     - relevant observation subset for current turn (keyword-based retrieval, item + token capped)

4. **Compaction always includes observations**
   - Before compaction, extension observes compaction candidates.
   - Compaction summary is generated from current OM observations.
   - `/om-observe` can trigger overwrite-style compaction (force mode behavior).

5. **Persistent state**
   - Session custom entries: `observational-memory-state`
   - Optional SQLite persistence by scope.

---

## Reflection

Following [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) design, the Reflector condenses observations into a single consolidated memory block that **replaces** the original observations entirely. The reflected output becomes the assistant's only memory — anything omitted is permanently forgotten.

Key behavior:
- `/om-reflect` **observes pending segments first** (Mastra pattern: Observer always runs before Reflector), then reflects on the full observation set.
- Reflection rewrites the **same canonical memory fields** used for injection and compaction: `observations`, `currentTask`, `suggestedResponse`.
- Auto reflection can trigger after observe based on thresholds.
- Aggressive reflection can run before compaction.
- The reflector prompt gives explicit compression targets (20-40% moderate, 40-60% aggressive) and instructs the model to condense older items more while keeping recent details.

---

## High-level flow (graph)

```mermaid
flowchart TD
  A[Conversation turns] --> B[Pending segments buffer]
  B --> C[Observe trigger: om-observe or auto]
  C --> D[Observer model compresses transcript]
  D --> E[Merge into observations state]
  E --> F{Reflect trigger}
  F -->|periodic threshold| F1[Observe pending segments first]
  F -->|manual /om-reflect| F1
  F -->|pre-compaction enabled| F1
  F1 --> G[Reflector condenses observations]
  F -->|no trigger| H[Use current observations]
  G -->|replaces observations| H
  H --> I{memoryInjectionMode}
  I -->|all| J[Inject full observations]
  I -->|core_relevant| K[Inject core plus relevant]
  J --> L[LLM call]
  K --> L
  H --> M[Compaction summary from observations]
```

---

## Commands

- `/om-status`
  - Shows OM status (scope, config source, injection mode, token counts, runs).

- `/om-config`
  - Shows active config values.

- `/om-config reload`
  - Reloads config from `om-config.json`.

- `/om-config edit`
  - Opens in-Pi JSON editor and saves config (project-local path).

- `/om-observe`
  - Forces observation now.
  - If `forceObserveAutoCompact=true`, also triggers force compaction flow.

- `/om-observe --no-compact`
  - Force observe without triggering compaction.

- `/om-reflect`
  - Observes any pending segments first, then reflects on all observations.
  - Reflection output **replaces** all existing observations.

- `/om-reflect --aggressive`
  - Same as above but with aggressive compression (targets 40-60% size reduction).

- `/om-observations`
  - Prints current compressed observations + task/next-step fields.

- `/om-clear`
  - Clears OM state.

---

## Config (`om-config.json`)

```json
{
  "recentTurnBudgetTokens": 12000,
  "maxObservationItems": 1200,
  "maxObserverTranscriptChars": 200000,
  "maxReflectorObservationsChars": 240000,
  "geminiCliModel": "gemini-2.5-flash",
  "forceObserveAutoCompact": true,
  "memoryInjectionMode": "all",
  "coreMemoryMaxTokens": 500,
  "relevantObservationMaxItems": 20,
  "relevantObservationMaxTokens": 1400,
  "enableReflection": true,
  "reflectEveryNObservations": 3,
  "reflectWhenObservationTokensOver": 3000,
  "reflectBeforeCompaction": true,
  "autoObservePendingTokenThreshold": 8000
}
```

### Deep config guide

#### 1) Observation input sizing

- `recentTurnBudgetTokens`
  - **What:** max recent non-system conversation budget kept for each call.
  - **Higher:** better continuity, more prompt cost.
  - **Lower:** cheaper prompts, higher risk of missing fresh context.
  - **Typical range:** `6000-20000`.

- `maxObserverTranscriptChars`
  - **What:** hard character cap sent to the observer/compressor.
  - **Higher:** preserves more history during observation runs.
  - **Lower:** faster/cheaper observation, may clip older details.
  - **Typical range:** `100000-300000`.

#### 2) Memory state size

- `maxObservationItems`
  - **What:** max number of merged observation lines retained.
  - **Higher:** richer long-term memory but can grow noisy.
  - **Lower:** cleaner and cheaper, but more aggressive forgetting.
  - **Typical range:** `300-2000`.

- `maxReflectorObservationsChars`
  - **What:** cap for observation text passed to reflector prompts.
  - **Higher:** deeper reflection quality.
  - **Lower:** quicker reflection loops.
  - **Typical range:** `100000-300000`.

#### 3) Model and trigger behavior

- `geminiCliModel`
  - **What:** Gemini CLI model used first for compression.
  - **Tip:** choose faster model for high-frequency observe loops, stronger model for quality-sensitive projects.

- `forceObserveAutoCompact`
  - **What:** if true, `/om-observe` also triggers a force compaction path.
  - **Use true when:** you want observe+compact as one operation.
  - **Use false when:** you want to inspect observations before compaction.

- `enableReflection`
  - **What:** enables reflector stage.
  - **Use true when:** you want periodic consolidation.

- `reflectEveryNObservations`
  - **What:** periodic trigger after this many successful observe runs.
  - **Lower:** more frequent cleanup, higher model usage.
  - **Higher:** less overhead, more raw observation growth.

- `reflectWhenObservationTokensOver`
  - **What:** token-trigger threshold for reflection.
  - **Lower:** reflection runs sooner.
  - **Higher:** reflection waits for larger memory blocks.

- `reflectBeforeCompaction`
  - **What:** runs aggressive reflection before compaction summary generation.
  - **Use true when:** compaction boundaries should snapshot best-possible memory.

- `autoObservePendingTokenThreshold`
  - **What:** auto-triggers observation when pending segment tokens exceed this value. Set to `0` to disable.
  - **Default:** `8000`.
  - **Why:** prevents deadlock on large context windows where compaction never triggers because the context hook trims messages before Pi sees high usage.
  - **Lower:** more frequent auto-observations, keeps observations fresher.
  - **Higher:** fewer auto-observation runs, larger batches per observation.

#### 4) Injection strategy

- `memoryInjectionMode`
  - `"all"`:
    - inject all observations each model call.
    - strongest continuity, highest token use.
  - `"core_relevant"`:
    - inject compact core + query-relevant subset.
    - better efficiency, may miss weakly related context.

#### 5) `core_relevant` tuning (used only when mode is `core_relevant`)

- `coreMemoryMaxTokens`
  - **What:** cap for always-included core memory block.
  - **Too low:** important stable facts can drop.
  - **Too high:** token savings shrink.

- `relevantObservationMaxItems`
  - **What:** max retrieved lines for current-turn relevance.
  - **Too low:** brittle retrieval.
  - **Too high:** noisy and expensive.

- `relevantObservationMaxTokens`
  - **What:** token cap for relevant subset.
  - **Acts as final guardrail** when many lines are retrieved.

---

## Config tradeoff graph

```mermaid
flowchart TD
  A[Injection mode tradeoff] --> B[all mode]
  A --> C[core_relevant balanced]
  A --> D[core_relevant aggressive caps]

  B --> B1[Continuity: high]
  B --> B2[Token cost: high]

  C --> C1[Continuity: medium-high]
  C --> C2[Token cost: medium]

  D --> D1[Continuity: medium]
  D --> D2[Token cost: low]
```

---

## Practical presets

### Reliability-first

```json
{
  "memoryInjectionMode": "all",
  "recentTurnBudgetTokens": 16000,
  "maxObservationItems": 1500
}
```

### Balanced

```json
{
  "memoryInjectionMode": "core_relevant",
  "coreMemoryMaxTokens": 700,
  "relevantObservationMaxItems": 24,
  "relevantObservationMaxTokens": 1600
}
```

### Cost-first

```json
{
  "memoryInjectionMode": "core_relevant",
  "recentTurnBudgetTokens": 8000,
  "coreMemoryMaxTokens": 350,
  "relevantObservationMaxItems": 12,
  "relevantObservationMaxTokens": 900
}
```

---

## Storage and env flags

- `PI_OM_SCOPE=thread|resource`
- `PI_OM_SQLITE=1`
- `PI_OM_SQLITE_PATH=/absolute/path/to/om.sqlite`
- `PI_OM_GEMINI_MODEL=gemini-2.5-flash` (override default Gemini CLI model)

Notes:
- `resource` scope auto-enables SQLite.
- Config load order:
  1. `.pi/extensions/observational-memory/om-config.json` (project)
  2. `~/.pi/agent/extensions/observational-memory/om-config.json` (global)
  3. defaults in code

---

## Recommended usage

- Keep `memoryInjectionMode="all"` when you want maximum continuity reliability.
- Use `memoryInjectionMode="core_relevant"` to reduce per-call prompt cost.
- Run `/om-observe` before manual `/compact` when you want fresh memory snapshot.
- Use `/om-config edit` for fast tuning in Pi.
