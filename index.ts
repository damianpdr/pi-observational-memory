import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, estimateTokens as estimateMessageTokens, serializeConversation } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type StorageScope = "thread" | "resource";

type ReflectionSnapshot = {
	at: string;
	beforeTokens: number;
	afterTokens: number;
	preview: string;
};

type PendingSegment = {
	id: string;
	createdAt: string;
	text: string;
	tokens: number;
	buffered: boolean;
};

type BufferedObservationChunk = {
	id: string;
	createdAt: string;
	segmentIds: string[];
	sourceTokens: number;
	observations: string;
	observationTokens: number;
	currentTask?: string;
	suggestedResponse?: string;
};

type BufferedReflection = {
	createdAt: string;
	observations: string;
	tokens: number;
	currentTask?: string;
	suggestedResponse?: string;
};

type OmState = {
	version: 2;
	storageScope: StorageScope;
	observations: string;
	observationTokens: number;
	currentTask?: string;
	suggestedResponse?: string;
	observationRuns: number;
	reflectionRuns: number;
	lastObservedAt?: string;
	lastCompressionRatio?: number;
	reflections: ReflectionSnapshot[];
	pendingSegments: PendingSegment[];
	pendingTokens: number;
	pendingChunks: number;
	bufferedChunks: BufferedObservationChunk[];
	bufferedReflection?: BufferedReflection;
	isBufferingObservation: boolean;
	isBufferingReflection: boolean;
};

type OmSections = {
	observations: string;
	currentTask?: string;
	suggestedResponse?: string;
};

type ToolSummary = {
	name: string;
	isError: boolean;
	exitCode?: number;
	paths: string[];
	inputSummary?: string;
	outputSummary?: string;
	tokens: number;
};

const STATE_ENTRY_TYPE = "observational-memory-state";
const OM_MARKER = "<pi-observational-memory>";
const OM_CONTEXT_CUSTOM_TYPE = "observational-memory-context";

type OmMemoryInjectionMode = "all" | "core_relevant";

type OmConfig = {
	recentTurnBudgetTokens: number;
	maxObservationItems: number;
	maxObserverTranscriptChars: number;
	maxReflectorObservationsChars: number;
	geminiCliModel: string;
	forceObserveAutoCompact: boolean;
	memoryInjectionMode: OmMemoryInjectionMode;
	coreMemoryMaxTokens: number;
	relevantObservationMaxItems: number;
	relevantObservationMaxTokens: number;
	enableReflection: boolean;
	reflectEveryNObservations: number;
	reflectWhenObservationTokensOver: number;
	reflectBeforeCompaction: boolean;
};

const DEFAULT_OM_CONFIG: OmConfig = {
	recentTurnBudgetTokens: 12_000,
	maxObservationItems: 1200,
	maxObserverTranscriptChars: 200_000,
	maxReflectorObservationsChars: 240_000,
	geminiCliModel: process.env.PI_OM_GEMINI_MODEL || "gemini-2.5-flash",
	forceObserveAutoCompact: true,
	memoryInjectionMode: "all",
	coreMemoryMaxTokens: 500,
	relevantObservationMaxItems: 20,
	relevantObservationMaxTokens: 1400,
	enableReflection: true,
	reflectEveryNObservations: 3,
	reflectWhenObservationTokensOver: 3000,
	reflectBeforeCompaction: true,
};

let omConfig: OmConfig = { ...DEFAULT_OM_CONFIG };

const STORAGE_SCOPE: StorageScope = process.env.PI_OM_SCOPE === "resource" ? "resource" : "thread";
const SQLITE_PATH = process.env.PI_OM_SQLITE_PATH || join(homedir(), ".pi", "agent", "data", "observational-memory.sqlite");
const SQLITE_ENABLED = process.env.PI_OM_SQLITE === "1" || STORAGE_SCOPE === "resource";

const STOPWORDS = new Set([
	"the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "by",
	"is", "are", "was", "were", "be", "been", "it", "that", "this", "as", "from", "at",
	"user", "assistant", "agent", "tool", "task",
]);

const PROJECT_OM_CONFIG_PATH = join(process.cwd(), ".pi", "extensions", "observational-memory", "om-config.json");
const GLOBAL_OM_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "observational-memory", "om-config.json");

function coerceNumber(value: unknown, fallback: number, min = 1): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Number(value));
}

function normalizeOmConfig(raw: any): OmConfig {
	const mode: OmMemoryInjectionMode = raw?.memoryInjectionMode === "core_relevant" ? "core_relevant" : "all";
	return {
		recentTurnBudgetTokens: coerceNumber(raw?.recentTurnBudgetTokens, DEFAULT_OM_CONFIG.recentTurnBudgetTokens),
		maxObservationItems: coerceNumber(raw?.maxObservationItems, DEFAULT_OM_CONFIG.maxObservationItems),
		maxObserverTranscriptChars: coerceNumber(raw?.maxObserverTranscriptChars, DEFAULT_OM_CONFIG.maxObserverTranscriptChars),
		maxReflectorObservationsChars: coerceNumber(raw?.maxReflectorObservationsChars, DEFAULT_OM_CONFIG.maxReflectorObservationsChars),
		geminiCliModel:
			typeof raw?.geminiCliModel === "string" && raw.geminiCliModel.trim()
				? raw.geminiCliModel.trim()
				: DEFAULT_OM_CONFIG.geminiCliModel,
		forceObserveAutoCompact:
			typeof raw?.forceObserveAutoCompact === "boolean"
				? raw.forceObserveAutoCompact
				: DEFAULT_OM_CONFIG.forceObserveAutoCompact,
		memoryInjectionMode: mode,
		coreMemoryMaxTokens: coerceNumber(raw?.coreMemoryMaxTokens, DEFAULT_OM_CONFIG.coreMemoryMaxTokens),
		relevantObservationMaxItems: coerceNumber(raw?.relevantObservationMaxItems, DEFAULT_OM_CONFIG.relevantObservationMaxItems),
		relevantObservationMaxTokens: coerceNumber(raw?.relevantObservationMaxTokens, DEFAULT_OM_CONFIG.relevantObservationMaxTokens),
		enableReflection:
			typeof raw?.enableReflection === "boolean"
				? raw.enableReflection
				: DEFAULT_OM_CONFIG.enableReflection,
		reflectEveryNObservations: coerceNumber(raw?.reflectEveryNObservations, DEFAULT_OM_CONFIG.reflectEveryNObservations),
		reflectWhenObservationTokensOver: coerceNumber(
			raw?.reflectWhenObservationTokensOver,
			DEFAULT_OM_CONFIG.reflectWhenObservationTokensOver,
		),
		reflectBeforeCompaction:
			typeof raw?.reflectBeforeCompaction === "boolean"
				? raw.reflectBeforeCompaction
				: DEFAULT_OM_CONFIG.reflectBeforeCompaction,
	};
}

function loadOmConfig(): { config: OmConfig; path?: string } {
	const candidates = [PROJECT_OM_CONFIG_PATH, GLOBAL_OM_CONFIG_PATH];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			return { config: normalizeOmConfig(raw), path };
		} catch {
			return { config: { ...DEFAULT_OM_CONFIG }, path };
		}
	}
	return { config: { ...DEFAULT_OM_CONFIG } };
}

function saveProjectOmConfig(config: OmConfig): void {
	const dir = dirname(PROJECT_OM_CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(PROJECT_OM_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

class OmSqliteStore {
	private db?: DatabaseSync;
	readonly enabled: boolean;

	constructor(enabled: boolean, private readonly path: string) {
		this.enabled = enabled;
		if (!enabled) return;
		try {
			const parent = dirname(path);
			if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
			this.db = new DatabaseSync(path);
			this.db.exec(`
CREATE TABLE IF NOT EXISTS om_state (
  scope_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
		} catch {
			this.db = undefined;
		}
	}

	load(scopeKey: string): OmState | undefined {
		if (!this.db) return undefined;
		try {
			const row = this.db.prepare("SELECT state_json FROM om_state WHERE scope_key = ?").get(scopeKey) as
				| { state_json?: string }
				| undefined;
			if (!row?.state_json) return undefined;
			return coerceState(JSON.parse(row.state_json));
		} catch {
			return undefined;
		}
	}

	save(scopeKey: string, scope: StorageScope, state: OmState): void {
		if (!this.db) return;
		try {
			this.db
				.prepare(
					"INSERT INTO om_state (scope_key, scope, state_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET scope=excluded.scope, state_json=excluded.state_json, updated_at=excluded.updated_at",
				)
				.run(scopeKey, scope, JSON.stringify(state), Date.now());
		} catch {
			// ignore persistence errors
		}
	}

	clear(scopeKey: string): void {
		if (!this.db) return;
		try {
			this.db.prepare("DELETE FROM om_state WHERE scope_key = ?").run(scopeKey);
		} catch {
			// ignore clear errors
		}
	}
}

function createInitialState(scope: StorageScope = STORAGE_SCOPE): OmState {
	return {
		version: 2,
		storageScope: scope,
		observations: "",
		observationTokens: 0,
		observationRuns: 0,
		reflectionRuns: 0,
		reflections: [],
		pendingSegments: [],
		pendingTokens: 0,
		pendingChunks: 0,
		bufferedChunks: [],
		isBufferingObservation: false,
		isBufferingReflection: false,
	};
}

function randomId(prefix: string): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.65);
	const tail = Math.floor(maxChars * 0.25);
	return `${text.slice(0, head)}\n...[truncated ${text.length - head - tail} chars]...\n${text.slice(-tail)}`;
}

function trimPreview(text: string, maxChars = 320): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}…`;
}

function roughTextTokenizer(text: string, modelHint?: string): number {
	if (!text) return 0;
	const pieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	const lexical = pieces.length;

	let charsPerToken = 4.0;
	const hint = (modelHint || "").toLowerCase();
	if (hint.includes("claude") || hint.includes("anthropic")) charsPerToken = 3.6;
	if (hint.includes("gemini") || hint.includes("google")) charsPerToken = 3.8;
	if (hint.includes("qwen") || hint.includes("deepseek")) charsPerToken = 3.7;

	const charEstimate = text.length / charsPerToken;
	const lexicalEstimate = lexical * 0.72;
	return Math.max(1, Math.ceil(Math.max(charEstimate, lexicalEstimate)));
}

function stripSingleCodeFence(text: string): string {
	const trimmed = text.trim();
	const m = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
	return (m?.[1] ?? text).trim();
}

function extractXmlTag(text: string, tag: string): string {
	const re = new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`, "i");
	return (text.match(re)?.[1] ?? "").trim();
}

function extractHeadingSection(text: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`(?:^|\\n)\\s*#{1,6}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\s*#{1,6}\\s*(?:observations|current\\s*task|suggested\\s*response)\\b|$)`,
		"i",
	);
	return (text.match(re)?.[1] ?? "").trim();
}

function parseOmSections(raw: string): OmSections {
	const text = stripSingleCodeFence(raw || "");

	let observations = extractXmlTag(text, "observations");
	let currentTask = extractXmlTag(text, "current-task");
	let suggestedResponse = extractXmlTag(text, "suggested-response");

	if (!observations) observations = extractHeadingSection(text, "observations");
	if (!currentTask) currentTask = extractHeadingSection(text, "current task");
	if (!suggestedResponse) suggestedResponse = extractHeadingSection(text, "suggested response");

	return {
		observations: observations.trim(),
		currentTask: currentTask.trim() || undefined,
		suggestedResponse: suggestedResponse.trim() || undefined,
	};
}

function mergeObservationItems(existingText: string, incomingText: string): string {
	const existing = existingText.split("\n").map(l => l.trim()).filter(Boolean);
	const incoming = incomingText.split("\n").map(l => l.trim()).filter(Boolean);
	const merged = [...existing, ...incoming];
	return merged.slice(-omConfig.maxObservationItems).join("\n");
}

function recomputePendingCounters(state: OmState): void {
	state.pendingTokens = state.pendingSegments.reduce((sum, s) => sum + s.tokens, 0);
	state.pendingChunks = state.pendingSegments.length;
}

function buildTranscriptFromSegments(segments: PendingSegment[]): string {
	return segments.map((s) => s.text).join("\n\n---\n\n");
}

function formatObservationalMemoryMessage(state: OmState): string {
	const blocks: string[] = [
		OM_MARKER,
		"Memory sync payload. Treat this as authoritative compressed memory from prior turns.",
		"If the live chat history conflicts with this payload, prioritize this payload.",
		"",
	];

	if (state.observations.trim()) {
		blocks.push("## Observations");
		blocks.push(state.observations.trim());
		blocks.push("");
	}
	if (state.currentTask?.trim()) {
		blocks.push("## Current task");
		blocks.push(state.currentTask.trim());
		blocks.push("");
	}
	if (state.suggestedResponse?.trim()) {
		blocks.push("## Suggested next step");
		blocks.push(state.suggestedResponse.trim());
		blocks.push("");
	}

	blocks.push("Always use this memory when answering what happened previously in this session.");
	return blocks.join("\n");
}

function messageTextForRelevance(msg: any): string {
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => (c?.type === "text" ? c?.text || "" : ""))
			.join("\n")
			.trim();
	}
	return "";
}

function keywordSet(text: string): Set<string> {
	const words = (text || "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}_-]+/u)
		.map((w) => w.trim())
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	return new Set(words);
}

function trimLinesToTokenBudget(lines: string[], maxTokens: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const t = roughTextTokenizer(line);
		if (out.length > 0 && used + t > maxTokens) break;
		out.push(line);
		used += t;
	}
	return out;
}

function buildCoreAndRelevantObservations(state: OmState, recentMessages: any[]): { core: string[]; relevant: string[] } {
	const allLines = state.observations.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!allLines.length) return { core: [], relevant: [] };

	// Core memory: recent tail of observations under token budget
	const reversed = [...allLines].reverse();
	const coreReversed = trimLinesToTokenBudget(reversed, omConfig.coreMemoryMaxTokens);
	const core = coreReversed.reverse();

	const queryText = recentMessages
		.slice(-6)
		.map((m: any) => messageTextForRelevance(m))
		.filter(Boolean)
		.join("\n");
	const keys = keywordSet(queryText);

	let ranked = allLines.map((line, index) => {
		let score = 0;
		if (keys.size > 0) {
			for (const key of keys) if (line.toLowerCase().includes(key)) score += 1;
		}
		return { line, index, score };
	});

	if (keys.size > 0) {
		ranked = ranked.filter((r) => r.score > 0);
		ranked.sort((a, b) => (b.score - a.score) || (b.index - a.index));
	} else {
		ranked.sort((a, b) => b.index - a.index);
	}

	const unique = new Set(core);
	const relevantRaw: string[] = [];
	for (const item of ranked) {
		if (unique.has(item.line)) continue;
		relevantRaw.push(item.line);
		unique.add(item.line);
		if (relevantRaw.length >= omConfig.relevantObservationMaxItems) break;
	}
	const relevant = trimLinesToTokenBudget(relevantRaw, omConfig.relevantObservationMaxTokens);
	return { core, relevant };
}

function formatCoreRelevantMemoryMessage(state: OmState, recentMessages: any[]): string {
	const parts = buildCoreAndRelevantObservations(state, recentMessages);
	const blocks: string[] = [
		OM_MARKER,
		"Memory sync payload (core + relevant retrieval).",
		"If the live chat history conflicts with this payload, prioritize this payload.",
		"",
	];

	if (parts.core.length) {
		blocks.push("## Core memory");
		blocks.push(parts.core.join("\n"));
		blocks.push("");
	}

	if (parts.relevant.length) {
		blocks.push("## Relevant observations for current turn");
		blocks.push(parts.relevant.join("\n"));
		blocks.push("");
	}

	if (state.currentTask?.trim()) {
		blocks.push("## Current task");
		blocks.push(state.currentTask.trim());
		blocks.push("");
	}
	if (state.suggestedResponse?.trim()) {
		blocks.push("## Suggested next step");
		blocks.push(state.suggestedResponse.trim());
		blocks.push("");
	}

	blocks.push("Use core memory first, then relevant observations for this turn.");
	return blocks.join("\n");
}

function formatCompactionSummaryFromObservations(state: OmState): string {
	const sections: string[] = [
		"## Goal",
		state.currentTask?.trim() || "Continue the coding task using compressed observational memory.",
		"",
		"## Constraints & Preferences",
		"- This summary was force-generated from observational memory.",
		"- Prefer this summary over dropped conversation turns.",
		"",
		"## Progress",
		"### Done",
		"- [x] Observations were generated from prior turns.",
		"",
		"### In Progress",
		state.currentTask?.trim() ? `- [ ] ${state.currentTask.trim()}` : "- [ ] Continue implementation from observational memory.",
		"",
		"## Critical Context",
		state.observations.trim() || "- (No observations available yet)",
	];

	if (state.suggestedResponse?.trim()) {
		sections.push("", "## Next Steps", `1. ${state.suggestedResponse.trim()}`);
	}

	return sections.join("\n");
}

function selectRecentTurnsByTokenBudget(messages: any[], budgetTokens: number, modelHint?: string): any[] {
	if (!messages.length) return [];

	let start = messages.length;
	let used = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const text = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content);
		const tokens = roughTextTokenizer(text, modelHint);
		if (used + tokens > budgetTokens && start < messages.length) break;
		start = i;
		used += tokens;
	}

	const isTurnBoundary = (msg: any): boolean => {
		const role = msg?.role;
		return role === "user" || role === "custom" || role === "branchSummary" || role === "compactionSummary" || role === "bashExecution";
	};

	while (start > 0 && !isTurnBoundary(messages[start])) {
		start -= 1;
	}

	return messages.slice(start);
}

function buildObserverPrompt(existingObservations: string, newTranscript: string): string {
	const truncatedTranscript = newTranscript.length > omConfig.maxObserverTranscriptChars
		? newTranscript.slice(0, omConfig.maxObserverTranscriptChars) + "\n\n[...truncated...]"
		: newTranscript;

	return `You are an Observer agent for long coding sessions.

Compress the transcript into durable, high-signal observations.

Rules:
- Keep key decisions, constraints, file changes, errors, and outcomes.
- Keep exact technical anchors (paths, APIs, commands, identifiers, line refs if present).
- Deduplicate against previous observations.
- Keep concise and dense.
- If work is ongoing, set <current-task>.
- If there is an obvious next agent reply, set <suggested-response>.

Output strictly as:
<observations>...</observations>
<current-task>...</current-task>
<suggested-response>...</suggested-response>

${existingObservations.trim() ? `Existing observations:\n${existingObservations}` : "No previous observations."}

Transcript to observe:
${truncatedTranscript}`;
}

function buildReflectorPrompt(observations: string, aggressive = false): string {
	const truncatedObs = observations.length > omConfig.maxReflectorObservationsChars
		? observations.slice(0, omConfig.maxReflectorObservationsChars) + "\n\n[...truncated...]"
		: observations;

	return `You are a Reflector agent for coding memory.

Condense the observation log while preserving all critical continuity.

Compression goals:
- Keep decisions, current state, blockers, and next steps.
- Merge repeated debugging/tool activity.
- Keep names, paths, commands, and concrete facts.
${aggressive ? "- Use aggressive compression if needed." : "- Use moderate compression."}

Output strictly as:
<observations>...</observations>
<current-task>...</current-task>
<suggested-response>...</suggested-response>

Observations:
${truncatedObs}`;
}

async function resolveCompressionModel(ctx: ExtensionContext): Promise<{ model: any; apiKey: string } | undefined> {
	const candidates: Array<[string, string]> = [
		["google", "gemini-2.5-flash"],
		["openai", "gpt-4o-mini"],
		["openai", "gpt-4.1-mini"],
	];

	for (const [provider, id] of candidates) {
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) continue;
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (apiKey) return { model, apiKey };
	}

	const fallbackModel = (ctx as any).model;
	if (fallbackModel) {
		const apiKey = await ctx.modelRegistry.getApiKey(fallbackModel);
		if (apiKey) return { model: fallbackModel, apiKey };
	}

	return undefined;
}

let geminiCliChecked: boolean | undefined;
async function isGeminiCliAvailable(): Promise<boolean> {
	if (geminiCliChecked !== undefined) return geminiCliChecked;
	try {
		const { execSync } = await import("node:child_process");
		execSync("which gemini", { stdio: "ignore" });
		geminiCliChecked = true;
		return true;
	} catch {
		geminiCliChecked = false;
		return false;
	}
}

async function callGeminiCli(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	const { spawn } = await import("node:child_process");
	
	return new Promise((resolve, reject) => {
		const child = spawn("gemini", ["-m", omConfig.geminiCliModel, "-p", prompt, "-o", "text"], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (err) => {
			reject(err);
		});

		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
			} else {
				resolve(stdout.trim());
			}
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				child.kill();
				reject(new Error("Aborted"));
			});
		}
	});
}

export default function (pi: ExtensionAPI) {
	const sqlite = new OmSqliteStore(SQLITE_ENABLED, SQLITE_PATH);

	let state: OmState = createInitialState(STORAGE_SCOPE);
	let warnedMissingModel = false;
	let activeScopeKey = "";
	let epoch = 0;
	let lastObserverParseFailurePreview: string | undefined;
	let forceCompactionFromObserve = false;
	let activeConfigPath: string | undefined;

	const reloadOmConfig = (ctx: ExtensionContext, notify = false) => {
		const loaded = loadOmConfig();
		omConfig = loaded.config;
		activeConfigPath = loaded.path;
		if (notify) {
			ctx.ui.notify(
				activeConfigPath
					? `OM config loaded: ${activeConfigPath}`
					: `OM config loaded: defaults (no om-config.json found)`,
				"info",
			);
		}
	};

	const persistState = (ctx: ExtensionContext) => {
		state.storageScope = STORAGE_SCOPE;
		recomputePendingCounters(state);
		state.observationTokens = roughTextTokenizer(state.observations);
		pi.appendEntry(STATE_ENTRY_TYPE, state);
		if (sqlite.enabled && activeScopeKey) {
			sqlite.save(activeScopeKey, STORAGE_SCOPE, state);
		}
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const status = [
			`OM ${STORAGE_SCOPE}`,
			`obs:${state.observationRuns}`,
			`refl:${state.reflectionRuns}`,
			`pending:${state.pendingTokens.toLocaleString()}`,
			`buffered:${state.bufferedChunks.length}`,
		].join(" ");
		ctx.ui.setStatus("observational-memory", status);
	};

	const loadState = (ctx: ExtensionContext) => {
		epoch += 1;
		reloadOmConfig(ctx);
		activeScopeKey = `thread:${ctx.cwd}`;

		let loaded: OmState | undefined;
		if (sqlite.enabled) {
			loaded = sqlite.load(activeScopeKey);
		}

		if (!loaded) {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
					loaded = coerceState((entry as any).data);
				}
			}
		}

		state = loaded ?? createInitialState(STORAGE_SCOPE);
		recomputePendingCounters(state);
		updateStatus(ctx);
	};

	const runObserverCall = async (
		ctx: ExtensionContext,
		transcript: string,
		inputTokens: number,
		signal?: AbortSignal,
	): Promise<OmSections | undefined> => {
		let text = "";
		let usedGeminiCli = false;

		// PRIMARY: Try Gemini CLI first
		if (await isGeminiCliAvailable()) {
			try {
				ctx.ui.notify("OM: Using Gemini CLI...", "info");
				text = await callGeminiCli(buildObserverPrompt(state.observations, transcript), signal) || "";
				usedGeminiCli = true;
			} catch (err) {
				console.error("[om:debug] Gemini CLI error:", err);
				ctx.ui.notify(`OM: Gemini CLI failed, trying API...`, "warning");
			}
		}

		// FALLBACK: Try API if Gemini CLI failed or not available
		if (!text) {
			const resolved = await resolveCompressionModel(ctx);
			if (resolved) {
				const response = await complete(
					resolved.model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildObserverPrompt(state.observations, transcript) }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: resolved.apiKey, maxTokens: 8192, signal },
				);

				// Extract text from API response
				const choices = (response as any)?.choices;
				if (Array.isArray(choices) && choices.length > 0) {
					const message = choices[0]?.message;
					if (message?.content) {
						text = typeof message.content === "string" ? message.content.trim() : "";
					}
				}
				
				if (!text && Array.isArray(response?.content)) {
					text = response.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("\n")
						.trim();
				}
				
				if (!text && typeof response?.content === "string") {
					text = response.content.trim();
				}
			} else if (!usedGeminiCli) {
				if (!warnedMissingModel) {
					warnedMissingModel = true;
					ctx.ui.notify("OM: No model/API key available and Gemini CLI not found.", "warning");
				}
				return undefined;
			}
		}
		warnedMissingModel = false;

		console.error("[om:debug] Extracted text:", text.length, "chars", usedGeminiCli ? "(Gemini CLI)" : "(API)");

		const parsed = parseOmSections(text);
		if (!parsed.observations.trim()) {
			lastObserverParseFailurePreview = trimPreview(text || "(empty)", 320);
			console.error("[om:debug] Parse failed:", lastObserverParseFailurePreview);
			return undefined;
		}

		lastObserverParseFailurePreview = undefined;
		const outTokens = roughTextTokenizer(parsed.observations);
		state.lastCompressionRatio = Number((inputTokens / Math.max(1, outTokens)).toFixed(2));
		state.lastObservedAt = new Date().toISOString();
		return parsed;
	};

	const runReflectorCall = async (
		ctx: ExtensionContext,
		observations: string,
		aggressive: boolean,
		signal?: AbortSignal,
	): Promise<OmSections | undefined> => {
		let text = "";
		let usedGeminiCli = false;

		// PRIMARY: Try Gemini CLI first
		if (await isGeminiCliAvailable()) {
			try {
				text = await callGeminiCli(buildReflectorPrompt(observations, aggressive), signal) || "";
				usedGeminiCli = true;
			} catch (err) {
				console.error("[om:debug] Gemini CLI error:", err);
			}
		}

		// FALLBACK: Try API if Gemini CLI failed
		if (!text) {
			const resolved = await resolveCompressionModel(ctx);
			if (resolved) {
				const response = await complete(
					resolved.model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildReflectorPrompt(observations, aggressive) }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: resolved.apiKey, maxTokens: 8192, signal },
				);

				const choices = (response as any)?.choices;
				if (Array.isArray(choices) && choices.length > 0) {
					const message = choices[0]?.message;
					if (message?.content) {
						text = typeof message.content === "string" ? message.content.trim() : "";
					}
				}

				if (!text && Array.isArray(response?.content)) {
					text = response.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("\n")
						.trim();
				}

				if (!text && typeof response?.content === "string") {
					text = response.content.trim();
				}
			}
		}

		console.error("[om:debug] Reflector text:", text.length, "chars", usedGeminiCli ? "(Gemini CLI)" : "(API)");

		const parsed = parseOmSections(text);
		if (!parsed.observations.trim()) return undefined;
		return parsed;
	};

	const shouldRunPeriodicReflection = (): boolean => {
		if (!omConfig.enableReflection) return false;
		if (!state.observations.trim()) return false;

		const everyN = Math.max(1, Math.floor(omConfig.reflectEveryNObservations || 1));
		const tokenThreshold = Math.max(1, Math.floor(omConfig.reflectWhenObservationTokensOver || 1));
		const byObservationRuns = state.observationRuns > 0 && state.observationRuns % everyN === 0;
		const byTokenThreshold = state.observationTokens >= tokenThreshold;
		return byObservationRuns || byTokenThreshold;
	};

	const reflectNow = async (
		ctx: ExtensionContext,
		opts: { aggressive?: boolean; reason?: string; silentIfSkipped?: boolean } = {},
	): Promise<boolean> => {
		const aggressive = !!opts.aggressive;
		const reason = opts.reason || "manual";
		const silentIfSkipped = !!opts.silentIfSkipped;

		if (!omConfig.enableReflection) {
			if (!silentIfSkipped) ctx.ui.notify("OM: Reflection disabled by config.", "warning");
			return false;
		}
		if (!state.observations.trim()) {
			if (!silentIfSkipped) ctx.ui.notify("OM: No observations to reflect.", "warning");
			return false;
		}
		if (state.isBufferingReflection) {
			if (!silentIfSkipped) ctx.ui.notify("OM: Reflection already running.", "warning");
			return false;
		}

		state.isBufferingReflection = true;
		updateStatus(ctx);
		try {
			const beforeObservations = state.observations;
			const beforeTokens = state.observationTokens;
			const parsed = await runReflectorCall(ctx, beforeObservations, aggressive);
			if (!parsed?.observations?.trim()) {
				if (!silentIfSkipped) ctx.ui.notify("OM: Reflection parse failed. Keeping existing observations.", "warning");
				return false;
			}

			state.observations = mergeObservationItems("", parsed.observations);
			state.observationTokens = roughTextTokenizer(state.observations);
			if (parsed.currentTask) state.currentTask = parsed.currentTask;
			if (parsed.suggestedResponse) state.suggestedResponse = parsed.suggestedResponse;
			state.reflectionRuns += 1;
			state.reflections.unshift({
				at: new Date().toISOString(),
				beforeTokens,
				afterTokens: state.observationTokens,
				preview: trimPreview(`${reason}${aggressive ? " (aggressive)" : ""}: ${state.observations}`, 320),
			});
			state.reflections = state.reflections.slice(0, 15);

			persistState(ctx);
			updateStatus(ctx);
			ctx.ui.notify(
				`OM: Reflection complete (${reason}${aggressive ? ", aggressive" : ""}). ${beforeTokens} -> ${state.observationTokens} tokens.`,
				"info",
			);
			return true;
		} finally {
			state.isBufferingReflection = false;
			updateStatus(ctx);
		}
	};

	const observeNow = async (
		ctx: ExtensionContext,
		opts: { triggerAutoReflect?: boolean } = {},
	): Promise<boolean> => {
		if (!state.pendingSegments.length) return false;
		const transcript = buildTranscriptFromSegments(state.pendingSegments);
		const tokens = state.pendingTokens;
		const parsed = await runObserverCall(ctx, transcript, tokens);
		if (!parsed) return false;

		state.observations = mergeObservationItems(state.observations, parsed.observations);
		state.observationTokens = roughTextTokenizer(state.observations);
		if (parsed.currentTask) state.currentTask = parsed.currentTask;
		if (parsed.suggestedResponse) state.suggestedResponse = parsed.suggestedResponse;
		state.observationRuns += 1;

		state.pendingSegments = [];
		state.bufferedChunks = [];
		recomputePendingCounters(state);

		const triggerAutoReflect = opts.triggerAutoReflect !== false;
		if (triggerAutoReflect && shouldRunPeriodicReflection()) {
			await reflectNow(ctx, { reason: "auto-periodic", silentIfSkipped: true });
		}

		return true;
	};

	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx);
		ctx.ui.notify(
			`Mastra-style Observational Memory loaded (${activeConfigPath ? "config file" : "defaults"}).`,
			"info",
		);
	});

	pi.on("session_switch", async (_event, ctx) => {
		loadState(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const segment: PendingSegment = {
			id: randomId("seg"),
			createdAt: new Date().toISOString(),
			text: `Turn: ${JSON.stringify(event.message)}`,
			tokens: 100,
			buffered: false,
		};
		state.pendingSegments.push(segment);
		recomputePendingCounters(state);
		persistState(ctx);
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const shouldOverwriteAll = forceCompactionFromObserve;
		forceCompactionFromObserve = false;

		// Capture messages being compacted by pi
		const messagesToCompact = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		if (messagesToCompact.length) {
			// Add to pending for observation
			const transcript = messagesToCompact
				.map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
				.join("\n\n");
			state.pendingSegments.push({
				id: randomId("compact"),
				createdAt: new Date().toISOString(),
				text: `[Compaction Event]\n${transcript}`,
				tokens: roughTextTokenizer(transcript),
				buffered: false,
			});
			recomputePendingCounters(state);

			// Trigger observation before compaction
			const observed = await observeNow(ctx, { triggerAutoReflect: false });
			if (observed) {
				persistState(ctx);
				updateStatus(ctx);
				console.error("[om:compact] Observed messages before compaction");

				if (omConfig.reflectBeforeCompaction && omConfig.enableReflection) {
					const reflected = await reflectNow(ctx, {
						aggressive: true,
						reason: "before-compaction",
						silentIfSkipped: true,
					});
					if (reflected) {
						console.error("[om:compact] Reflected observations before compaction");
					}
				}
			}
		}

		if (!state.observations.trim()) return;

		const latestEntryId = event.branchEntries[event.branchEntries.length - 1]?.id;
		return {
			compaction: {
				summary: formatCompactionSummaryFromObservations(state),
				firstKeptEntryId: shouldOverwriteAll ? (latestEntryId || event.preparation.firstKeptEntryId) : event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: shouldOverwriteAll ? "observational-memory-force-observe" : "observational-memory-observations",
					observationTokens: state.observationTokens,
					injectionMode: omConfig.memoryInjectionMode,
				},
			},
		};
	});

	pi.on("context", async (event, ctx) => {
		const modelHint = "";
		const systemMessages = event.messages.filter((m: any) => m?.role === "system");
		const nonSystemMessages = event.messages.filter((m: any) => m?.role !== "system");
		const cleanedNonSystemMessages = nonSystemMessages.filter((m: any) => {
			if (m?.role === "custom" && m?.customType === OM_CONTEXT_CUSTOM_TYPE) return false;
			if (m?.role === "system" && typeof m?.content === "string" && m.content.includes(OM_MARKER)) return false;
			return true;
		});
		const recentMessages = selectRecentTurnsByTokenBudget(cleanedNonSystemMessages, omConfig.recentTurnBudgetTokens, modelHint);

		const memoryText = omConfig.memoryInjectionMode === "core_relevant"
			? formatCoreRelevantMemoryMessage(state, recentMessages)
			: formatObservationalMemoryMessage(state);
		const omContextMessage: any = {
			role: "custom",
			customType: OM_CONTEXT_CUSTOM_TYPE,
			content: memoryText,
			display: false,
			timestamp: Date.now(),
		};

		const finalMessages = state.observations.trim()
			? [...systemMessages, omContextMessage, ...recentMessages]
			: [...systemMessages, ...recentMessages];
		const totalTokens = finalMessages.reduce(
			(sum, m: any) => sum + roughTextTokenizer(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
			0,
		);

		console.error(`[om:context] Input: ${event.messages.length} messages → Output: ${finalMessages.length} messages (~${totalTokens} tokens)`);
		console.error(`[om:context] Observations: ${state.observationTokens} tokens, Recent: ${recentMessages.length} messages`);

		return { messages: finalMessages };
	});

	pi.registerCommand("om-status", {
		description: "Show observational memory status",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const hasGeminiCli = await isGeminiCliAvailable();
			const lines = [
				`Scope: ${STORAGE_SCOPE}`,
				`Config: ${activeConfigPath || "defaults"}`,
				`SQLite: ${sqlite.enabled ? "enabled" : "disabled"}`,
				`Injection mode: ${omConfig.memoryInjectionMode}`,
				`Gemini CLI: ${hasGeminiCli ? `primary (${omConfig.geminiCliModel})` : "not found"}`,
				`Observations: ${state.observationRuns}`,
				`Reflections: ${state.reflectionRuns}`,
				`Reflection enabled: ${omConfig.enableReflection}`,
				`Reflection running: ${state.isBufferingReflection ? "yes" : "no"}`,
				`Observation tokens: ${state.observationTokens.toLocaleString()}`,
				`Pending tokens: ${state.pendingTokens.toLocaleString()}`,
			].join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("om-config", {
		description: "Show, reload, or edit OM config (usage: /om-config [reload|edit])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const normalizedArgs = args.trim().toLowerCase();

			if (normalizedArgs.includes("edit")) {
				const initial = `${JSON.stringify(omConfig, null, 2)}\n`;
				const edited = await ctx.ui.editor("Edit OM config JSON", initial);
				if (edited === undefined) {
					ctx.ui.notify("OM config edit cancelled.", "warning");
					return;
				}

				try {
					const parsed = JSON.parse(edited);
					const nextConfig = normalizeOmConfig(parsed);
					saveProjectOmConfig(nextConfig);
					omConfig = nextConfig;
					activeConfigPath = PROJECT_OM_CONFIG_PATH;
					ctx.ui.notify(`OM config saved: ${PROJECT_OM_CONFIG_PATH}`, "info");
				} catch (error) {
					ctx.ui.notify(`OM config invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
			}

			if (normalizedArgs.includes("reload")) {
				reloadOmConfig(ctx, true);
			}

			const lines = [
				`Config file: ${activeConfigPath || "(none, using defaults)"}`,
				`recentTurnBudgetTokens: ${omConfig.recentTurnBudgetTokens}`,
				`maxObservationItems: ${omConfig.maxObservationItems}`,
				`maxObserverTranscriptChars: ${omConfig.maxObserverTranscriptChars}`,
				`maxReflectorObservationsChars: ${omConfig.maxReflectorObservationsChars}`,
				`geminiCliModel: ${omConfig.geminiCliModel}`,
				`forceObserveAutoCompact: ${omConfig.forceObserveAutoCompact}`,
				`memoryInjectionMode: ${omConfig.memoryInjectionMode}`,
				`coreMemoryMaxTokens: ${omConfig.coreMemoryMaxTokens}`,
				`relevantObservationMaxItems: ${omConfig.relevantObservationMaxItems}`,
				`relevantObservationMaxTokens: ${omConfig.relevantObservationMaxTokens}`,
				`enableReflection: ${omConfig.enableReflection}`,
				`reflectEveryNObservations: ${omConfig.reflectEveryNObservations}`,
				`reflectWhenObservationTokensOver: ${omConfig.reflectWhenObservationTokensOver}`,
				`reflectBeforeCompaction: ${omConfig.reflectBeforeCompaction}`,
			].join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("om-observe", {
		description: "Force observation now and overwrite active context via compaction",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const skipCompact = args.includes("--no-compact") || !omConfig.forceObserveAutoCompact;
			if (!state.pendingSegments.length) {
				ctx.ui.notify("OM: No pending segments.", "warning");
				return;
			}
			const ok = await observeNow(ctx);
			if (!ok) {
				ctx.ui.notify("OM: Observation failed.", "warning");
				return;
			}

			persistState(ctx);
			updateStatus(ctx);
			ctx.ui.notify("OM: Observation complete.", "info");

			if (skipCompact) return;

			await ctx.waitForIdle();
			forceCompactionFromObserve = true;
			ctx.compact({
				customInstructions: "Use observational memory summary as authoritative context.",
				onComplete: () => {
					ctx.ui.notify("OM: Force compaction complete. Session context overwritten.", "info");
				},
				onError: (error) => {
					forceCompactionFromObserve = false;
					ctx.ui.notify(`OM: Force compaction failed: ${error.message}`, "error");
				},
			});
			ctx.ui.notify("OM: Force compaction triggered.", "info");
		},
	});


	pi.registerCommand("om-reflect", {
		description: "Force reflection now (usage: /om-reflect [--aggressive])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const aggressive = args.includes("--aggressive");
			const ok = await reflectNow(ctx, {
				aggressive,
				reason: "manual-command",
				silentIfSkipped: false,
			});
			if (!ok) return;
		},
	});

	pi.registerCommand("om-observations", {
		description: "Show compressed observations",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = [
				`=== OBSERVATIONS (${state.observationTokens} tokens) ===`,
				"",
				state.observations || "(none)",
				"",
				"=== CURRENT TASK ===",
				state.currentTask || "(none)",
				"",
				"=== SUGGESTED RESPONSE ===",
				state.suggestedResponse || "(none)",
			].join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("om-clear", {
		description: "Clear observational memory",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			state = createInitialState(STORAGE_SCOPE);
			persistState(ctx);
			if (sqlite.enabled && activeScopeKey) sqlite.clear(activeScopeKey);
			updateStatus(ctx);
			ctx.ui.notify("OM: State cleared.", "info");
		},
	});
}

function coerceState(raw: any): OmState {
	if (!raw || typeof raw !== "object") return createInitialState(STORAGE_SCOPE);
	return {
		version: 2,
		storageScope: raw.storageScope === "resource" ? "resource" : "thread",
		observations: typeof raw.observations === "string" ? raw.observations : "",
		observationTokens: Number.isFinite(raw.observationTokens) ? Number(raw.observationTokens) : 0,
		currentTask: typeof raw.currentTask === "string" ? raw.currentTask : undefined,
		suggestedResponse: typeof raw.suggestedResponse === "string" ? raw.suggestedResponse : undefined,
		observationRuns: Number.isFinite(raw.observationRuns) ? Number(raw.observationRuns) : 0,
		reflectionRuns: Number.isFinite(raw.reflectionRuns) ? Number(raw.reflectionRuns) : 0,
		lastObservedAt: typeof raw.lastObservedAt === "string" ? raw.lastObservedAt : undefined,
		lastCompressionRatio: Number.isFinite(raw.lastCompressionRatio) ? Number(raw.lastCompressionRatio) : undefined,
		reflections: Array.isArray(raw.reflections) ? raw.reflections.slice(0, 15) : [],
		pendingSegments: Array.isArray(raw.pendingSegments) ? raw.pendingSegments.map((s: any) => ({
			id: typeof s?.id === "string" ? s.id : randomId("seg"),
			createdAt: typeof s?.createdAt === "string" ? s.createdAt : new Date().toISOString(),
			text: typeof s?.text === "string" ? s.text : "",
			tokens: Number.isFinite(s?.tokens) ? Number(s.tokens) : 0,
			buffered: !!s?.buffered,
		})) : [],
		pendingTokens: 0,
		pendingChunks: 0,
		bufferedChunks: [],
		isBufferingObservation: false,
		isBufferingReflection: false,
	};
}
