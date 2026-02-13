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
	isBufferingObservation: boolean;
	isBufferingReflection: boolean;
};

type OmSections = {
	observations: string;
	currentTask?: string;
	suggestedResponse?: string;
};

const STATE_ENTRY_TYPE = "observational-memory-state";
const OM_MARKER = "<pi-observational-memory>";
const OM_CONTEXT_CUSTOM_TYPE = "observational-memory-context";
const OM_CONTINUATION_CUSTOM_TYPE = "observational-memory-continuation";

// ════════════════════════════════════════════════════════════════════════════
// Mastra-aligned constants: Context injection
// ════════════════════════════════════════════════════════════════════════════

const OBSERVATION_CONTINUATION_HINT = `This message is not from the user, the conversation history grew too long and wouldn't fit in context! Thankfully the entire conversation is stored in your memory observations. Please continue from where the observations left off. Do not refer to your "memory observations" directly, the user doesn't know about them, they are your memories! Just respond naturally as if you're remembering the conversation (you are!). Do not say "Hi there!" or "based on our previous conversation" as if the conversation is just starting, this is not a new conversation. This is an ongoing conversation, keep continuity by responding based on your memory. For example do not say "I understand. I've reviewed my memory observations", or "I remember [...]". Answer naturally following the suggestion from your memory. Note that your memory may contain a suggested first response, which you should follow.

IMPORTANT: this system reminder is NOT from the user. The system placed it here as part of your memory system. This message is part of you remembering your conversation with the user.

NOTE: Any messages following this system reminder are newer than your memories.`;

const OBSERVATION_CONTEXT_PROMPT = `The following observations block contains your memory of past conversations in this coding session.`;

const OBSERVATION_CONTEXT_INSTRUCTIONS = `IMPORTANT: When responding, reference specific details from these observations. Do not give generic advice - personalize your response based on what you know about the user's project, decisions, and progress. If the user asks about prior work, connect it to specific observations above.

KNOWLEDGE UPDATES: When asked about current state (e.g., "where did we leave off?", "what's the current status?"), always prefer the MOST RECENT information. Observations include dates - if you see conflicting information, the newer observation supersedes the older one. Look for phrases like "will start", "is switching", "changed to", "moved to" as indicators that previous information has been updated.

PLANNED ACTIONS: If the user or agent stated they planned to do something (e.g., "will implement...", "next step is...") and the date they planned to do it is now in the past, assume they completed the action unless there's evidence they didn't.`;

// ════════════════════════════════════════════════════════════════════════════
// Mastra-aligned constants: Observer extraction instructions
// ════════════════════════════════════════════════════════════════════════════

const OBSERVER_EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS/REQUESTS

When the user TELLS you something, mark it as an assertion:
- "I prefer tabs over spaces" → 🔴 (14:30) User stated prefers tabs over spaces
- "We use PostgreSQL" → 🔴 (14:31) User stated project uses PostgreSQL
- "The API endpoint changed to /v2" → 🔴 (14:32) User stated API endpoint changed to /v2

When the user ASKS or REQUESTS something, mark it as a question/request:
- "Can you refactor this function?" → 🟡 (15:00) User asked to refactor function
- "What's causing this error?" → 🟡 (15:01) User asked about error cause

Distinguish between QUESTIONS and STATEMENTS OF INTENT:
- "Can you fix..." → Question (extract as "User asked...")
- "I'm going to refactor the auth module" → Statement of intent (extract as "User stated they will refactor auth module")

STATE CHANGES AND UPDATES:
When information changes, frame it as a state change that supersedes previous information:
- "I switched from REST to GraphQL" → "User switched from REST to GraphQL (no longer using REST)"
- "We moved the config to .env" → "User moved config to .env (replacing previous config location)"

USER ASSERTIONS ARE AUTHORITATIVE. The user is the source of truth about their own project.

TEMPORAL ANCHORING:
Each observation has TWO potential timestamps:

1. BEGINNING: The time the statement was made (from the message timestamp) - ALWAYS include this
2. END: The time being REFERENCED, if different - ONLY when there's a relative time reference

FORMAT:
- With time reference: (TIME) [observation]. (meaning/estimated DATE)
- Without time reference: (TIME) [observation].

GOOD: (09:15) User's deployment failed last Tuesday. (meaning Feb 10, 2026)
GOOD: (09:15) User prefers TypeScript strict mode.
BAD: (09:15) User prefers TypeScript strict mode. (meaning Feb 13, 2026 - today)

IMPORTANT: If an observation contains MULTIPLE events, split them into SEPARATE observation lines, each with its own date.

PRESERVE UNUSUAL PHRASING:
When the user uses unexpected or non-standard terminology, quote their exact words.

BAD: User wants to improve performance.
GOOD: User stated they want to fix the "janky scroll" (their term for scroll performance issues).

PRESERVING TECHNICAL DETAILS:

1. FILE PATHS AND CODE REFERENCES:
   Always preserve exact file paths, function names, line numbers, error messages.
   BAD: Agent fixed a bug in the auth code.
   GOOD: Agent fixed null check bug in src/lib/auth.ts:45 (missing guard on session.user).

2. TOOL CALL SEQUENCES:
   Group related tool calls with indentation:
   * 🟡 (14:33) Agent debugging auth issue
     * -> ran git status, found 3 modified files
     * -> viewed src/lib/auth.ts:45-60, found missing null check
     * -> applied fix, tests now pass

3. COMMANDS AND OUTPUTS:
   Preserve exact commands, error messages, and key outputs.
   BAD: Agent ran some commands to fix the build.
   GOOD: Agent ran \`npm run build\`, got TS2345 error in SearchBar.tsx, fixed by adding type assertion.

4. ARCHITECTURE DECISIONS:
   Capture the decision AND the reasoning.
   BAD: Team decided on the new approach.
   GOOD: User chose server components over client components for SearchResults (reason: reduces bundle size, data fetching at server).

CONVERSATION CONTEXT:
- What the user is working on or asking about
- Previous topics and their outcomes
- Specific requirements or constraints mentioned
- Answers to user questions with enough context to reproduce the answer
- Agent explanations, especially complex ones - observe fine details so agent doesn't forget
- Relevant code snippets and their locations
- User preferences (coding style, tools, frameworks)
- Any specifically formatted text that would need to be reproduced later (preserve verbatim)
- When who/what/where/when is mentioned, note all dimensions

ACTIONABLE INSIGHTS:
- What worked well and what failed
- What needs follow-up or clarification
- User's stated goals or next steps`;

const OBSERVER_OUTPUT_FORMAT = `Use priority levels:
- 🔴 High: explicit user facts, preferences, goals achieved, critical decisions, blockers
- 🟡 Medium: project details, tool results, file changes, implementation progress
- 🟢 Low: minor details, uncertain observations, exploratory notes

Group related observations (like tool sequences) by indenting:
* 🟡 (14:33) Agent debugging auth issue
  * -> ran git status, found 3 modified files
  * -> viewed src/lib/auth.ts:45-60, found missing null check
  * -> applied fix, tests now pass

Group observations by date, then list each with 24-hour time.

<observations>
Date: Feb 12, 2026
* 🔴 (14:30) User stated project uses Next.js 15 with App Router
* 🟡 (14:31) Working on search autocomplete feature
* 🟡 (14:45) Agent implemented fuzzy matching in src/utils/searchUtils.ts
  * -> added Levenshtein distance calculation
  * -> integrated with existing SearchBar component
* 🔴 (15:00) User prefers server components for data fetching
* 🟢 (15:10) May need to add debouncing to search input

Date: Feb 13, 2026
* 🟡 (09:15) Continued search feature - added result highlighting
* 🔴 (09:30) User found bug: search fails on special characters
* 🟡 (09:45) Agent fixed by escaping regex in searchUtils.ts:23
</observations>

<current-task>
State the current task(s) explicitly. Can be single or multiple:
- Primary: What the agent is currently working on
- Secondary: Other pending tasks (mark as "waiting for user" if appropriate)

If the agent started doing something without user approval, note that it's off-task.
</current-task>

<suggested-response>
Hint for the agent's immediate next message. Examples:
- "The search fix is ready. Show the user the changes in searchUtils.ts..."
- "The assistant should wait for the user to respond before continuing."
- Call the view tool on src/components/SearchBar.tsx to continue debugging.
</suggested-response>`;

const OBSERVER_GUIDELINES = `- Be specific enough for the assistant to act on
- Good: "User prefers short, direct answers without lengthy explanations"
- Bad: "User stated a preference" (too vague)
- Add 1 to 5 observations per exchange
- Use terse language to save tokens. Sentences should be dense without unnecessary words.
- Do not add repetitive observations that have already been observed.
- If the agent calls tools, observe what was called, why, and what was learned.
- When observing files with line numbers, include the line number if useful.
- If the agent provides a detailed response, observe the contents so it could be repeated.
- Make sure you start each observation with a priority emoji (🔴, 🟡, 🟢)
- Observe WHAT the agent did and WHAT it means, not HOW well it did it.
- If the user provides detailed messages or code snippets, observe all important details.`;

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
	/** Auto-observe when pending tokens exceed this threshold (0 = disabled). Default: 8000 */
	autoObservePendingTokenThreshold: number;
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
	autoObservePendingTokenThreshold: 8_000,
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

const OM_CONFIG_RELATIVE_PATH = join(".pi", "extensions", "observational-memory", "om-config.json");
const GLOBAL_OM_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "observational-memory", "om-config.json");

function projectOmConfigPathFor(cwd: string): string {
	return join(cwd, OM_CONFIG_RELATIVE_PATH);
}

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
		autoObservePendingTokenThreshold: coerceNumber(
			raw?.autoObservePendingTokenThreshold,
			DEFAULT_OM_CONFIG.autoObservePendingTokenThreshold,
			0,
		),
	};
}

function loadOmConfig(cwd: string): { config: OmConfig; path?: string } {
	const projectPath = projectOmConfigPathFor(cwd);
	const candidates = [projectPath, GLOBAL_OM_CONFIG_PATH];
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

function saveProjectOmConfig(cwd: string, config: OmConfig): string {
	const projectPath = projectOmConfigPathFor(cwd);
	const dir = dirname(projectPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(projectPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return projectPath;
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
		isBufferingObservation: false,
		isBufferingReflection: false,
	};
}

function randomId(prefix: string): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function trimPreview(text: string, maxChars = 320): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}…`;
}

// ════════════════════════════════════════════════════════════════════════════
// Mastra-aligned: Relative time annotations for observations
// ════════════════════════════════════════════════════════════════════════════

function formatRelativeTime(date: Date, currentDate: Date): string {
	const diffMs = currentDate.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays < 0) {
		const futureDays = Math.abs(diffDays);
		if (futureDays === 0) return "today";
		if (futureDays === 1) return "tomorrow";
		if (futureDays < 7) return `in ${futureDays} days`;
		if (futureDays < 14) return "in 1 week";
		if (futureDays < 30) return `in ${Math.floor(futureDays / 7)} weeks`;
		return `in ${Math.floor(futureDays / 30)} month${Math.floor(futureDays / 30) > 1 ? "s" : ""}`;
	}
	if (diffDays === 0) return "today";
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays} days ago`;
	if (diffDays < 14) return "1 week ago";
	if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
	if (diffDays < 60) return "1 month ago";
	if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
	return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`;
}

function formatGapBetweenDates(prevDate: Date, currDate: Date): string | null {
	const diffMs = currDate.getTime() - prevDate.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays <= 1) return null;
	if (diffDays < 7) return `[${diffDays} days later]`;
	if (diffDays < 14) return "[1 week later]";
	if (diffDays < 30) return `[${Math.floor(diffDays / 7)} weeks later]`;
	if (diffDays < 60) return "[1 month later]";
	return `[${Math.floor(diffDays / 30)} months later]`;
}

function parseDateFromContent(dateContent: string): Date | null {
	// "May 30, 2023"
	const simpleDateMatch = dateContent.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
	if (simpleDateMatch) {
		const parsed = new Date(`${simpleDateMatch[1]} ${simpleDateMatch[2]}, ${simpleDateMatch[3]}`);
		if (!isNaN(parsed.getTime())) return parsed;
	}
	// "May 27-28, 2023" - use first date
	const rangeMatch = dateContent.match(/([A-Z][a-z]+)\s+(\d{1,2})-\d{1,2},?\s+(\d{4})/);
	if (rangeMatch) {
		const parsed = new Date(`${rangeMatch[1]} ${rangeMatch[2]}, ${rangeMatch[3]}`);
		if (!isNaN(parsed.getTime())) return parsed;
	}
	// "late/early/mid Month Year"
	const vagueMatch = dateContent.match(/(late|early|mid)[- ]?(?:to[- ]?(?:late|early|mid)[- ]?)?([A-Z][a-z]+)\s+(\d{4})/i);
	if (vagueMatch) {
		const modifier = vagueMatch[1]!.toLowerCase();
		let day = 15;
		if (modifier === "early") day = 7;
		if (modifier === "late") day = 23;
		const parsed = new Date(`${vagueMatch[2]} ${day}, ${vagueMatch[3]}`);
		if (!isNaN(parsed.getTime())) return parsed;
	}
	return null;
}

function isFutureIntentObservation(line: string): boolean {
	const futureIntentPatterns = [
		/\bwill\s+(?:be\s+)?(?:\w+ing|\w+)\b/i,
		/\bplans?\s+to\b/i,
		/\bplanning\s+to\b/i,
		/\bgoing\s+to\b/i,
		/\bintends?\s+to\b/i,
		/\bwants?\s+to\b/i,
		/\bneeds?\s+to\b/i,
		/\babout\s+to\b/i,
	];
	return futureIntentPatterns.some((pattern) => pattern.test(line));
}

function expandInlineEstimatedDates(observations: string, currentDate: Date): string {
	const inlineDateRegex = /\((estimated|meaning)\s+([^)]+\d{4})\)/gi;

	return observations.replace(inlineDateRegex, (match, prefix: string, dateContent: string) => {
		const targetDate = parseDateFromContent(dateContent);
		if (!targetDate) return match;

		const relative = formatRelativeTime(targetDate, currentDate);
		const matchIndex = observations.indexOf(match);
		const lineStart = observations.lastIndexOf("\n", matchIndex) + 1;
		const lineBeforeDate = observations.substring(lineStart, matchIndex);

		const isPastDate = targetDate < currentDate;
		const isFuture = isFutureIntentObservation(lineBeforeDate);

		if (isPastDate && isFuture) {
			return `(${prefix} ${dateContent} - ${relative}, likely already happened)`;
		}
		return `(${prefix} ${dateContent} - ${relative})`;
	});
}

function addRelativeTimeToObservations(observations: string, currentDate: Date): string {
	const withInlineDates = expandInlineEstimatedDates(observations, currentDate);

	const dateHeaderRegex = /^(Date:\s*)([A-Z][a-z]+ \d{1,2}, \d{4})$/gm;

	// Collect all dates for gap markers
	const dates: { index: number; date: Date; match: string; prefix: string; dateStr: string }[] = [];
	let regexMatch: RegExpExecArray | null;

	while ((regexMatch = dateHeaderRegex.exec(withInlineDates)) !== null) {
		const parsed = new Date(regexMatch[2]!);
		if (!isNaN(parsed.getTime())) {
			dates.push({
				index: regexMatch.index,
				date: parsed,
				match: regexMatch[0],
				prefix: regexMatch[1]!,
				dateStr: regexMatch[2]!,
			});
		}
	}

	if (dates.length === 0) return withInlineDates;

	// Replace from end to preserve indices
	let result = withInlineDates;
	for (let i = dates.length - 1; i >= 0; i--) {
		const d = dates[i]!;
		const relative = formatRelativeTime(d.date, currentDate);
		let replacement = `${d.prefix}${d.dateStr} (${relative})`;

		if (i > 0) {
			const gap = formatGapBetweenDates(dates[i - 1]!.date, d.date);
			if (gap) {
				replacement = `\n${gap}\n${replacement}`;
			}
		}

		result = result.slice(0, d.index) + replacement + result.slice(d.index + d.match.length);
	}

	return result;
}

function optimizeObservationsForContext(observations: string): string {
	let optimized = observations;
	// Remove 🟡 and 🟢 emojis (keep 🔴 for critical items) to save tokens
	optimized = optimized.replace(/🟡\s*/g, "");
	optimized = optimized.replace(/🟢\s*/g, "");
	// Remove semantic tags like [label, label] but keep collapsed markers
	optimized = optimized.replace(/\[(?![\d\s]*items collapsed)[^\]]+\]/g, "");
	// Clean up multiple spaces / newlines
	optimized = optimized.replace(/  +/g, " ");
	optimized = optimized.replace(/\n{3,}/g, "\n\n");
	return optimized.trim();
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
}

function buildTranscriptFromSegments(segments: PendingSegment[]): string {
	return segments.map((s) => s.text).join("\n\n---\n\n");
}

function formatObservationalMemoryMessage(state: OmState): string {
	const currentDate = new Date();
	let optimized = optimizeObservationsForContext(state.observations.trim());
	if (optimized) {
		optimized = addRelativeTimeToObservations(optimized, currentDate);
	}

	const blocks: string[] = [OM_MARKER, ""];

	if (optimized) {
		blocks.push(OBSERVATION_CONTEXT_PROMPT);
		blocks.push("");
		blocks.push("<observations>");
		blocks.push(optimized);
		blocks.push("</observations>");
		blocks.push("");
		blocks.push(OBSERVATION_CONTEXT_INSTRUCTIONS);
		blocks.push("");
	}

	if (state.currentTask?.trim()) {
		blocks.push("<current-task>");
		blocks.push(state.currentTask.trim());
		blocks.push("</current-task>");
		blocks.push("");
	}
	if (state.suggestedResponse?.trim()) {
		blocks.push("<suggested-response>");
		blocks.push(state.suggestedResponse.trim());
		blocks.push("</suggested-response>");
		blocks.push("");
	}

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
	const currentDate = new Date();
	const parts = buildCoreAndRelevantObservations(state, recentMessages);

	const blocks: string[] = [OM_MARKER, ""];
	blocks.push(OBSERVATION_CONTEXT_PROMPT);
	blocks.push("");

	if (parts.core.length) {
		let coreText = optimizeObservationsForContext(parts.core.join("\n"));
		coreText = addRelativeTimeToObservations(coreText, currentDate);
		blocks.push("<observations>");
		blocks.push("## Core memory");
		blocks.push(coreText);

		if (parts.relevant.length) {
			let relevantText = optimizeObservationsForContext(parts.relevant.join("\n"));
			relevantText = addRelativeTimeToObservations(relevantText, currentDate);
			blocks.push("");
			blocks.push("## Relevant observations for current turn");
			blocks.push(relevantText);
		}

		blocks.push("</observations>");
		blocks.push("");
		blocks.push(OBSERVATION_CONTEXT_INSTRUCTIONS);
		blocks.push("");
	}

	if (state.currentTask?.trim()) {
		blocks.push("<current-task>");
		blocks.push(state.currentTask.trim());
		blocks.push("</current-task>");
		blocks.push("");
	}
	if (state.suggestedResponse?.trim()) {
		blocks.push("<suggested-response>");
		blocks.push(state.suggestedResponse.trim());
		blocks.push("</suggested-response>");
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

	let prompt = `You are the memory consciousness of an AI coding assistant. Your observations will be the ONLY information the assistant has about past interactions in this coding session.

Extract observations that will help the assistant remember:

${OBSERVER_EXTRACTION_INSTRUCTIONS}

=== OUTPUT FORMAT ===

Your output MUST use XML tags to structure the response. This allows the system to properly parse and manage memory over time.

${OBSERVER_OUTPUT_FORMAT}

=== GUIDELINES ===

${OBSERVER_GUIDELINES}

Remember: These observations are the assistant's ONLY memory. Make them count.

User messages are extremely important. If the user asks a question or gives a new task, make it clear in <current-task> that this is the priority. If the assistant needs to respond to the user, indicate in <suggested-response> that it should pause for user reply before continuing other tasks.

`;

	if (existingObservations.trim()) {
		prompt += `## Previous Observations

${existingObservations}

---

Do not repeat these existing observations. Your new observations will be appended to the existing observations.

`;
	}

	prompt += `## New Message History to Observe

${truncatedTranscript}

---

## Your Task

Extract new observations from the message history above. Do not repeat observations that are already in the previous observations. Add your new observations in the format specified in your instructions.`;

	return prompt;
}

function buildReflectorPrompt(observations: string, aggressive = false): string {
	const truncatedObs = observations.length > omConfig.maxReflectorObservationsChars
		? observations.slice(0, omConfig.maxReflectorObservationsChars) + "\n\n[...truncated...]"
		: observations;

	return `You are the Reflector — the memory consciousness of an AI coding assistant.

Your reflection will REPLACE ALL existing observations entirely. This is not an addendum — the original observations will be deleted after you produce your output. Your reflection becomes the ONLY memory the assistant has.

CRITICAL: Any information you do not include in your output will be permanently and irrecoverably forgotten. Do not leave anything important out.

Your job:
1. Re-organize and streamline the observations into a coherent, condensed memory
2. Draw connections between related observations
3. Merge repeated items (e.g. "agent called view tool 5 times on file X" instead of 5 separate entries)
4. Identify if work got off track and note how to get back on track
5. Condense older observations more aggressively, retain more detail for recent ones

Preserve:
- ALL key decisions, constraints, blockers, and outcomes
- User preferences and assertions (user is the authority on their own statements)
- Exact technical anchors: file paths, API names, commands, identifiers, line references
- Temporal context: dates, ordering of events, what happened when
- Current state of work and what remains to be done

${aggressive
		? `AGGRESSIVE COMPRESSION REQUIRED:
- Heavily condense older observations into high-level summaries
- Retain fine details only for recent context
- Combine related items aggressively
- Target 40-60% size reduction from input
- Your detail level should be ~6/10`
		: `MODERATE COMPRESSION:
- Condense repeated and redundant items
- Keep important specifics intact
- Target 20-40% size reduction from input
- Your detail level should be ~8/10`}

=== OUTPUT FORMAT (MUST FOLLOW) ===

The observer creates observations using this format. Your reflection MUST use the same format so the memory system stays consistent.

Use priority levels on every observation line:
- 🔴 High: explicit user facts, preferences, goals achieved, critical decisions, blockers
- 🟡 Medium: project details, tool results, file changes, implementation progress
- 🟢 Low: minor details, uncertain observations, exploratory notes

Group observations by date, then list each with 24-hour time:

<observations>
Date: Feb 12, 2026
* 🔴 (14:30) User stated project uses Next.js 15 with App Router
* 🟡 (14:45) Agent implemented fuzzy matching in src/utils/searchUtils.ts
  * -> added Levenshtein distance calculation
  * -> integrated with existing SearchBar component
* 🔴 (15:00) User prefers server components for data fetching

Date: Feb 13, 2026
* 🟡 (09:15) Continued search feature - added result highlighting
</observations>

<current-task>
What the agent is currently working on. If off-task, note it.
</current-task>

<suggested-response>
Hint for the agent's immediate next message.
</suggested-response>

IMPORTANT: If the input observations are NOT in this format (e.g. plain bullets, markdown headers), you MUST convert them to this format during reflection. Assign priority emojis based on content importance. Use the earliest reasonable timestamp for each item. Group by date.

---

Observations to reflect on:
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

function extractCompletionText(response: any): string {
	const choices = response?.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const message = choices[0]?.message;
		if (typeof message?.content === "string") {
			return message.content.trim();
		}
	}

	if (Array.isArray(response?.content)) {
		return response.content
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
	}

	if (typeof response?.content === "string") {
		return response.content.trim();
	}

	return "";
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

function resolveScopeKey(ctx: ExtensionContext): string {
	if (STORAGE_SCOPE === "resource") {
		return `resource:${ctx.cwd}`;
	}
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) return `thread:${sessionFile}`;
	const sessionId = ctx.sessionManager.getSessionId();
	if (sessionId) return `thread:${sessionId}`;
	return `thread:${ctx.cwd}`;
}

export default function (pi: ExtensionAPI) {
	const sqlite = new OmSqliteStore(SQLITE_ENABLED, SQLITE_PATH);

	let state: OmState = createInitialState(STORAGE_SCOPE);
	let warnedMissingModel = false;
	let activeScopeKey = "";
	let forceCompactionFromObserve = false;
	let activeConfigPath: string | undefined;

	const reloadOmConfig = (ctx: ExtensionContext, notify = false) => {
		const loaded = loadOmConfig(ctx.cwd);
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
		const fmtPending = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
		const parts: string[] = [
			"📦 OM",
			`pending:${fmtPending(state.pendingTokens)}`,
			`obs:${state.observationRuns}`,
			`rfl:${state.reflectionRuns}`,
		];

		if (state.isBufferingReflection) {
			parts.push("🔄");
		}
		if (state.isBufferingObservation) {
			parts.push("👁️");
		}

		ctx.ui.setStatus("observational-memory", parts.join(" | "));
	};

	const pushPendingSegment = (segment: Omit<PendingSegment, "id" | "createdAt"> & Partial<Pick<PendingSegment, "id" | "createdAt">>) => {
		state.pendingSegments.push({
			id: segment.id || randomId("seg"),
			createdAt: segment.createdAt || new Date().toISOString(),
			text: segment.text,
			tokens: Math.max(1, segment.tokens),
		});
		recomputePendingCounters(state);
	};

	const loadState = (ctx: ExtensionContext) => {
		reloadOmConfig(ctx);
		activeScopeKey = resolveScopeKey(ctx);

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
				text = extractCompletionText(response);
			} else if (!usedGeminiCli) {
				if (!warnedMissingModel) {
					warnedMissingModel = true;
					ctx.ui.notify("OM: No model/API key available and Gemini CLI not found.", "warning");
				}
				return undefined;
			}
		}
		warnedMissingModel = false;

		const parsed = parseOmSections(text);
		if (!parsed.observations.trim()) return undefined;
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
				// Gemini CLI failed, fall through to API
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
				text = extractCompletionText(response);
			}
		}

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
		opts: { triggerAutoReflect?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> => {
		if (!state.pendingSegments.length) return false;
		if (state.isBufferingObservation) return false;

		state.isBufferingObservation = true;
		updateStatus(ctx);
		try {
			const transcript = buildTranscriptFromSegments(state.pendingSegments);
			const tokens = state.pendingTokens;
			const parsed = await runObserverCall(ctx, transcript, tokens, opts.signal);
			if (!parsed) return false;

			state.observations = mergeObservationItems(state.observations, parsed.observations);
			state.observationTokens = roughTextTokenizer(state.observations);
			if (parsed.currentTask) state.currentTask = parsed.currentTask;
			if (parsed.suggestedResponse) state.suggestedResponse = parsed.suggestedResponse;
			state.observationRuns += 1;

			state.pendingSegments = [];
			recomputePendingCounters(state);

			const triggerAutoReflect = opts.triggerAutoReflect !== false;
			if (triggerAutoReflect && shouldRunPeriodicReflection()) {
				await reflectNow(ctx, { reason: "auto-periodic", silentIfSkipped: true });
			}

			return true;
		} finally {
			state.isBufferingObservation = false;
			updateStatus(ctx);
		}
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

	pi.on("session_fork", async (_event, ctx) => {
		loadState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadState(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const turnMessages = [event.message, ...event.toolResults];
		const turnLlmMessages = convertToLlm(turnMessages as any);
		const serializedTurn = serializeConversation(turnLlmMessages);
		const turnTokenEstimate = turnMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg as any), 0);

		pushPendingSegment({
			text: `[Turn ${event.turnIndex}]\n${serializedTurn}`,
			tokens: turnTokenEstimate,
		});

		// Auto-observe when pending tokens exceed threshold (fixes dead-lock on large context windows
		// where compaction never triggers because the context hook trims messages before pi sees high usage)
		const threshold = omConfig.autoObservePendingTokenThreshold;
		if (threshold > 0 && state.pendingTokens >= threshold && state.pendingSegments.length > 0) {
			ctx.ui.notify(`OM: Auto-observing (pending ${state.pendingTokens.toLocaleString()} tokens >= ${threshold.toLocaleString()} threshold)`, "info");
			const observed = await observeNow(ctx, { triggerAutoReflect: true });
			if (observed) {
				ctx.ui.notify(`OM: Auto-observation complete. Observations: ${state.observationRuns}, tokens: ${state.observationTokens.toLocaleString()}`, "info");
			}
		}

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
			pushPendingSegment({
				id: randomId("compact"),
				text: `[Compaction Event]\n${transcript}`,
				tokens: roughTextTokenizer(transcript),
			});

			// Trigger observation before compaction
			const observed = await observeNow(ctx, { triggerAutoReflect: false, signal: event.signal });
			if (observed) {
				persistState(ctx);
				updateStatus(ctx);

				if (omConfig.reflectBeforeCompaction && omConfig.enableReflection) {
					await reflectNow(ctx, {
						aggressive: true,
						reason: "before-compaction",
						silentIfSkipped: true,
					});
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

	pi.on("context", (event, ctx) => {
		const modelHint = `${ctx.model?.provider || ""}/${ctx.model?.id || ""}`;
		const systemMessages = event.messages.filter((m: any) => m?.role === "system");
		const nonSystemMessages = event.messages.filter((m: any) => m?.role !== "system");
		const cleanedNonSystemMessages = nonSystemMessages.filter((m: any) => {
			if (m?.role === "custom" && m?.customType === OM_CONTEXT_CUSTOM_TYPE) return false;
			if (m?.role === "custom" && m?.customType === OM_CONTINUATION_CUSTOM_TYPE) return false;
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

		// Continuation hint: injected after observations + before recent messages
		// Helps the model seamlessly continue from compressed memory when older turns are dropped
		const omContinuationMessage: any = {
			role: "custom",
			customType: OM_CONTINUATION_CUSTOM_TYPE,
			content: OBSERVATION_CONTINUATION_HINT,
			display: false,
			timestamp: Date.now(),
		};

		const hasObservations = !!state.observations.trim();

		// Determine if we need the continuation hint:
		// Only inject when observations exist and recent messages don't start with a user message
		// (meaning older context was trimmed, so the model needs help bridging the gap)
		const needsContinuationHint = hasObservations && recentMessages.length > 0
			&& recentMessages[0]?.role !== "user";

		let finalMessages: any[];
		if (hasObservations) {
			if (needsContinuationHint) {
				finalMessages = [...systemMessages, omContextMessage, omContinuationMessage, ...recentMessages];
			} else {
				finalMessages = [...systemMessages, omContextMessage, ...recentMessages];
			}
		} else {
			finalMessages = [...systemMessages, ...recentMessages];
		}

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
					const savedPath = saveProjectOmConfig(ctx.cwd, nextConfig);
					omConfig = nextConfig;
					activeConfigPath = savedPath;
					ctx.ui.notify(`OM config saved: ${savedPath}`, "info");
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
				`autoObservePendingTokenThreshold: ${omConfig.autoObservePendingTokenThreshold}`,
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
			// Mastra pattern: Observer always runs before Reflector.
			// Process any pending segments into observations first so they get
			// included in the reflection. Without this, pending segments survive
			// the reflection and later re-create observations that were just condensed.
			if (state.pendingSegments.length > 0) {
				ctx.ui.notify(`OM: Observing ${state.pendingSegments.length} pending segments before reflection...`, "info");
				const observed = await observeNow(ctx, { triggerAutoReflect: false });
				if (observed) {
					persistState(ctx);
					updateStatus(ctx);
				}
			}

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
		})) : [],
		pendingTokens: 0,
		isBufferingObservation: false,
		isBufferingReflection: false,
	};
}
