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
  "relevantObservationMaxTokens": 1400
}
```

### Field notes

- `recentTurnBudgetTokens` — token budget for recent non-system context kept each call.
- `maxObservationItems` — max merged observation lines retained in state.
- `maxObserverTranscriptChars` — max transcript size sent to observer model.
- `maxReflectorObservationsChars` — max observations size sent to reflector prompt.
- `geminiCliModel` — Gemini CLI model used for compression.
- `forceObserveAutoCompact` — if true, `/om-observe` triggers compaction automatically.
- `memoryInjectionMode` — `"all"` or `"core_relevant"`.
- `coreMemoryMaxTokens` — token cap for core memory in `core_relevant` mode.
- `relevantObservationMaxItems` — max relevant lines in `core_relevant` mode.
- `relevantObservationMaxTokens` — token cap for relevant lines in `core_relevant` mode.

---

## Storage and env flags

- `PI_OM_SCOPE=thread|resource`
- `PI_OM_SQLITE=1`
- `PI_OM_SQLITE_PATH=/absolute/path/to/om.sqlite`

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
