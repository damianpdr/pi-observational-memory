# Observational Memory config reference

This document contains the full `om-config.json` surface.

If you are new, start with the README quick presets first.

---

## Full default config

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

---

## Key-by-key guide

### `recentTurnBudgetTokens`
Max token budget for recent (non-system) messages kept in live context.
- Higher = better immediate continuity, more token cost
- Lower = cheaper, but can lose short-term detail
- Typical: `6000-20000`

### `maxObservationItems`
Hard cap on observation lines retained in state.
- Higher = more long-term memory
- Lower = less noise + lower memory size
- Typical: `300-2000`

### `maxObserverTranscriptChars`
Character cap for transcript passed to observer.
- Higher = richer compression input
- Lower = faster/cheaper observer calls
- Typical: `100000-300000`

### `maxReflectorObservationsChars`
Character cap for observation text passed to reflector.
- Higher = deeper reflection quality
- Lower = faster reflection cycles
- Typical: `100000-300000`

### `geminiCliModel`
Primary Gemini CLI model used for observer/reflector calls.
- Example: `gemini-2.5-flash`

### `forceObserveAutoCompact`
If true, `/om-observe` also triggers compaction flow.
- `true` = observe + compact as one operation
- `false` = observe only, compact later manually

### `memoryInjectionMode`
Controls how memory is inserted into prompt context.
- `"all"` = inject full observations (best continuity, highest cost)
- `"core_relevant"` = inject compact core + relevant subset (lower cost)

### `coreMemoryMaxTokens` *(core_relevant only)*
Token cap for always-included core memory.

### `relevantObservationMaxItems` *(core_relevant only)*
Max number of relevance-selected observations.

### `relevantObservationMaxTokens` *(core_relevant only)*
Token cap for relevance-selected block.

### `enableReflection`
Enables reflector stage.
- Reflection rewrites memory into cleaner, denser form

### `reflectEveryNObservations`
Periodic reflection trigger by successful observe count.
- Lower = more frequent cleanup
- Higher = fewer model calls

### `reflectWhenObservationTokensOver`
Reflection trigger by observation token size.
- Reflection runs when `observationTokens >= threshold`

### `reflectBeforeCompaction`
Run aggressive reflection before compaction summary generation.

### `autoObservePendingTokenThreshold`
Auto-run observer when pending segments reach this token count.
- `0` disables
- Default `8000`
- Useful safety valve when compaction is delayed and pending buffer grows

---

## Recommended profiles

### Simple (default)

```json
{
  "memoryInjectionMode": "all",
  "autoObservePendingTokenThreshold": 8000,
  "enableReflection": true,
  "reflectEveryNObservations": 3
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

## Environment variables

- `PI_OM_SCOPE=thread|resource`
- `PI_OM_SQLITE=1`
- `PI_OM_SQLITE_PATH=/absolute/path/to/om.sqlite`
- `PI_OM_GEMINI_MODEL=gemini-2.5-flash`

---

## Config resolution order

1. `.pi/extensions/observational-memory/om-config.json` (project)
2. `~/.pi/agent/extensions/observational-memory/om-config.json` (global)
3. built-in defaults
