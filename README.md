# Observational Memory (Pi extension)

Long-session memory for Pi.
It compresses old conversation/tool activity into compact "observations" and injects that memory back into context.

If you want the short version: **install, run `/om-status`, and forget about it**.

---

## Quick start (2 minutes)

### 1) Install

Put this extension at:

- `.pi/extensions/observational-memory/index.ts`

Optional project config:

- `.pi/extensions/observational-memory/om-config.json`

### 2) Start a Pi session

Run:

- `/om-status`

You should see scope, observation/reflection counters, and token counts.

### 3) Use it normally

The extension auto-buffers turns and keeps memory in the background.

### 4) Force a snapshot when needed

Run:

- `/om-observe`

This is useful before a manual compaction or before switching topics.

---

## What it does (simple)

1. **Observes** recent turn history and tool actions.
2. **Compresses** them into:
   - `observations`
   - `currentTask`
   - `suggestedResponse`
3. **Injects memory** into context on each LLM call.
4. **Reflects** periodically to keep memory compact and clean.
5. **Persists state** (session entries + optional SQLite).

---

## Daily commands

| Command | What it does |
|---|---|
| `/om-status` | Show current OM state |
| `/om-observe` | Force observe now |
| `/om-observe --no-compact` | Observe now, skip compaction trigger |
| `/om-reflect` | Force reflection now |
| `/om-reflect --aggressive` | Stronger reflection/compaction |
| `/om-observations` | Print current memory block |
| `/om-config` | Show active config |
| `/om-config reload` | Reload config from file |
| `/om-config edit` | Edit config in Pi |
| `/om-config preset <simple\|balanced\|max-memory>` | Apply preset and save project config |
| `/om-clear` | Reset all OM state |

---

## Minimal config most people need

```json
{
  "memoryInjectionMode": "all",
  "autoObservePendingTokenThreshold": 8000,
  "enableReflection": true,
  "reflectEveryNObservations": 3
}
```

That’s enough for almost all use cases.

---

## Presets

### 1) Simple (recommended default)

```json
{
  "memoryInjectionMode": "all",
  "autoObservePendingTokenThreshold": 8000,
  "enableReflection": true
}
```

### 2) Balanced (lower token cost)

```json
{
  "memoryInjectionMode": "core_relevant",
  "coreMemoryMaxTokens": 700,
  "relevantObservationMaxItems": 24,
  "relevantObservationMaxTokens": 1600
}
```

### 3) Max-memory (continuity first)

```json
{
  "memoryInjectionMode": "all",
  "recentTurnBudgetTokens": 16000,
  "maxObservationItems": 1500
}
```

---

## Where state/config live

- Project config: `.pi/extensions/observational-memory/om-config.json`
- Global config: `~/.pi/agent/extensions/observational-memory/om-config.json`
- Optional SQLite state: `~/.pi/agent/data/observational-memory.sqlite`

Config load order:
1. Project config
2. Global config
3. Code defaults

---

## Environment flags

- `PI_OM_SCOPE=thread|resource`
- `PI_OM_SQLITE=1`
- `PI_OM_SQLITE_PATH=/absolute/path/to/om.sqlite`
- `PI_OM_GEMINI_MODEL=gemini-2.5-flash`

---

## Troubleshooting

- **`/om-status` shows zero progress**
  - Run `/om-observe` manually once.
- **Memory feels stale**
  - Lower `autoObservePendingTokenThreshold` (e.g. 6000).
- **Prompt cost too high**
  - Switch to `memoryInjectionMode: "core_relevant"`.
- **Too many reflections**
  - Increase `reflectEveryNObservations`.

---

## Advanced docs

- Full config reference: `docs/config-reference.md`
