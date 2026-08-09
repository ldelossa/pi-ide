import { appendFile, readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	isToolCallEventType,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { IdeClient, isPidAlive, isPortListening, listLockfiles, type Lockfile, matchesCwd } from "./client.ts";
import {
	SUGGESTION_SYSTEM_PROMPT,
	buildSuggestionPrompt,
	parseSuggestionBlocks,
	prepareSuggestionCandidates,
	type SuggestionParams,
} from "./suggestion.ts";

const SUGGESTION_FLAG = "pi-ide-suggestion-model";
const SUGGESTION_DEBUG_LOG_FLAG = "pi-ide-suggestion-debug-log";

type Selection = { startLine: number; endLine: number; text: string };
type EditorState = { filePath: string | null; cursorLine: number | null; selection: Selection | null };

const MAX_SELECTION_LINES = 100;
const WIDGET_KEY = "pi-ide";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// --- Autoconnect config & state ---
const PI_IDE_SETTINGS_KEY = "pi-ide";
const STICKY_STATE_KEY = Symbol.for("@ldelossa/pi-ide:sticky-state");

type PiIdeSettings = {
	autoconnect?: boolean;
};

type StickyState = {
	lockfile?: Lockfile;
};

// --- Settings helpers ---

function extractPiIdeSettings(settings: Record<string, unknown>): PiIdeSettings {
	const raw = settings[PI_IDE_SETTINGS_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	return {
		autoconnect: typeof obj.autoconnect === "boolean" ? obj.autoconnect : undefined,
	};
}

function isAutoconnectEnabled(cwd: string): boolean {
	const manager = SettingsManager.create(cwd);
	const globalSettings = extractPiIdeSettings(manager.getGlobalSettings() as Record<string, unknown>);
	const projectSettings = extractPiIdeSettings(manager.getProjectSettings() as Record<string, unknown>);
	return projectSettings.autoconnect ?? globalSettings.autoconnect ?? true;
}

// --- Sticky state helpers ---

function getStickyState(): StickyState {
	const g = globalThis as typeof globalThis & Record<symbol, StickyState | undefined>;
	g[STICKY_STATE_KEY] ??= {};
	return g[STICKY_STATE_KEY]!;
}

function setStickyLockfile(lockfile: Lockfile): void {
	getStickyState().lockfile = lockfile;
}

function clearStickyLockfile(): void {
	delete getStickyState().lockfile;
}

function getStickyLockfile(): Lockfile | undefined {
	return getStickyState().lockfile;
}

function sameLockfile(a: Lockfile, b: Lockfile): boolean {
	return a.port === b.port && a.pid === b.pid && a.authToken === b.authToken;
}

let client: IdeClient | null = null;
let state: EditorState = { filePath: null, cursorLine: null, selection: null };
let ui: ExtensionUIContext | null = null;
let sessionCtx: ExtensionContext | null = null;
let inFlightSuggestions = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function disconnectFromIde(): void {
	if (!client) return;
	clearStickyLockfile();
	const old = client;
	client = null;
	old.close();
	resetState();
	inFlightSuggestions = 0;
	stopSpinner();
	renderWidget();
}

function resetState(): void {
	state = { filePath: null, cursorLine: null, selection: null };
}

function startSpinner(): void {
	if (spinnerTimer) return;
	spinnerTimer = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
		renderWidget();
	}, SPINNER_INTERVAL_MS);
}

function stopSpinner(): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = null;
	}
	spinnerFrame = 0;
}

function renderWidget(): void {
	if (!ui) return;
	if (!client?.isConnected()) {
		ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const ideName = client.lockfile.ideName;
	let body: string;
	if (state.selection && state.filePath) {
		body = `${ideName} · Lines ${state.selection.startLine + 1}-${state.selection.endLine + 1} selected in ${basename(state.filePath)}`;
	} else if (state.filePath) {
		body = `${ideName} · In ${basename(state.filePath)}`;
	} else {
		body = ideName;
	}
	if (inFlightSuggestions > 0) {
		body += ` · Suggesting ${SPINNER[spinnerFrame]}`;
	}
	ui.setWidget(WIDGET_KEY, [body]);
}

function onNotification(method: string, params: unknown): void {
	if (method !== "selection_changed" || !params || typeof params !== "object") return;
	const p = params as {
		text?: string;
		filePath?: string;
		selection?: { start: { line: number }; end: { line: number }; isEmpty: boolean };
	};
	if (!p.filePath || !p.selection) return;
	state.filePath = p.filePath;
	state.cursorLine = p.selection.start.line;
	state.selection = p.selection.isEmpty
		? null
		: { startLine: p.selection.start.line, endLine: p.selection.end.line, text: p.text ?? "" };
	renderWidget();
}

function renderEditorBlock(): string | null {
	if (!state.filePath) return null;
	const out = ["<editor>", `  <file>${state.filePath}</file>`];
	if (state.cursorLine !== null) out.push(`  <cursor>line ${state.cursorLine + 1}</cursor>`);
	if (state.selection) {
		const lines = state.selection.text.split("\n");
		const text =
			lines.length <= MAX_SELECTION_LINES
				? state.selection.text
				: `${lines.slice(0, MAX_SELECTION_LINES).join("\n")}\n... <truncated ${lines.length - MAX_SELECTION_LINES} more lines>`;
		out.push(`  <selection lines="${state.selection.startLine + 1}-${state.selection.endLine + 1}">`);
		out.push(text);
		out.push("  </selection>");
	}
	out.push("</editor>");
	return out.join("\n");
}

function parseDiffResult(result: { content?: { text?: string }[] }): { saved: boolean; text: string } {
	const items = result?.content ?? [];
	const marker = items[0]?.text;
	if (marker === "FILE_SAVED") return { saved: true, text: items[1]?.text ?? "" };
	return { saved: false, text: "" };
}

const MAX_DIAGNOSTICS = 50;

type Diagnostic = {
	severity: string;
	message: string;
	source?: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
};

async function fetchDiagnosticsBlock(): Promise<string | null> {
	if (!client?.isConnected()) return null;
	let result: { content?: { text?: string }[] };
	try {
		result = await client.callTool("getDiagnostics", {});
	} catch {
		return null;
	}
	const text = result?.content?.[0]?.text;
	if (!text) return null;
	let parsed: Record<string, Diagnostic[]>;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const lines: string[] = [];
	for (const [uri, items] of Object.entries(parsed)) {
		for (const d of items) {
			if (d.severity !== "Error" && d.severity !== "Warning") continue;
			lines.push(
				`${uri}:${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity}] ${d.message}`,
			);
			if (lines.length >= MAX_DIAGNOSTICS) break;
		}
		if (lines.length >= MAX_DIAGNOSTICS) break;
	}
	if (lines.length === 0) return null;
	return `<lsp_diagnostics>\n${lines.join("\n")}\n</lsp_diagnostics>`;
}

function applyEdits(original: string, edits: { oldText: string; newText: string }[]): string {
	let result = original;
	for (const edit of edits) {
		const idx = result.indexOf(edit.oldText);
		if (idx === -1) throw new Error("edit oldText not found in file");
		if (result.indexOf(edit.oldText, idx + 1) !== -1) {
			throw new Error("edit oldText not unique in file");
		}
		// slice+concat avoids String.replace's $N pattern interpretation.
		result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
	}
	return result;
}

async function logSuggestionDebug(
	pi: ExtensionAPI,
	entry: {
		model: string;
		params: SuggestionParams;
		userText: string;
		durationMs: number;
		stopReason: string;
		usage?: unknown;
		rawText: string;
		parsedBlocks: string[];
		returnedSuggestions: string[];
	},
): Promise<void> {
	const flagValue = pi.getFlag(SUGGESTION_DEBUG_LOG_FLAG);
	if (typeof flagValue !== "string" || !flagValue.trim()) return;
	try {
		await appendFile(
			flagValue.trim(),
			`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry }, null, 2)}\n---\n`,
			"utf8",
		);
	} catch {
		// Debug logging must never break suggestions.
	}
}

function resolveSuggestionModel(pi: ExtensionAPI, ctx: ExtensionContext, editorPref: string | undefined) {
	// Precedence: CLI flag (operator override) > editor-provided preference >
	// current session model.
	const flagValue = pi.getFlag(SUGGESTION_FLAG);
	const pick = (typeof flagValue === "string" && flagValue) ? flagValue : (editorPref || "");
	if (pick) {
		const slash = pick.indexOf("/");
		if (slash === -1) {
			throw new Error(`suggestion model expects provider/id, got "${pick}"`);
		}
		const provider = pick.slice(0, slash);
		const id = pick.slice(slash + 1);
		const m = ctx.modelRegistry.find(provider, id);
		if (!m) throw new Error(`model not found: ${pick}`);
		return m;
	}
	if (!ctx.model) throw new Error("no current model, no editor-provided model, and --pi-ide-suggestion-model not set");
	return ctx.model;
}

async function generateSuggestions(pi: ExtensionAPI, params: SuggestionParams, signal: AbortSignal): Promise<string[]> {
	if (!sessionCtx) throw new Error("session not yet started");
	const ctx = sessionCtx;
	const model = resolveSuggestionModel(pi, ctx, params.model);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`auth failed: ${auth.error}`);
	if (!auth.apiKey) throw new Error(`no API key for ${model.provider}`);

	const userText = buildSuggestionPrompt(params);
	const startedAt = Date.now();
	const response = await completeSimple(
		model,
		{
			systemPrompt: SUGGESTION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 1024,
			signal,
			cacheRetention: "short",
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `suggestion model stopped with ${response.stopReason}`);
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	const blocks = parseSuggestionBlocks(text);
	const returnedSuggestions = prepareSuggestionCandidates(blocks, params);
	await logSuggestionDebug(pi, {
		model: `${model.provider}/${model.id}`,
		params,
		userText,
		durationMs: Date.now() - startedAt,
		stopReason: response.stopReason,
		usage: response.usage,
		rawText: text,
		parsedBlocks: blocks,
		returnedSuggestions,
	});
	return returnedSuggestions;
}

type PickResult =
	| { kind: "selected"; lockfile: Lockfile }
	| { kind: "none" }
	| { kind: "cancelled" };

async function pickLockfile(
	cwd: string,
	ui: { select: (t: string, o: string[]) => Promise<string | undefined> },
	current?: Lockfile,
): Promise<PickResult> {
	const candidates = await findCandidateLockfiles(cwd);
	if (candidates.length === 0) return { kind: "none" };
	const labels = candidates.map((c) => {
		const folder = c.workspaceFolders[0] ?? "?";
		const marker = current && c.port === current.port && c.pid === current.pid ? " · (connected)" : "";
		return `${c.ideName} · ${folder} · pid=${c.pid} port=${c.port}${marker}`;
	});
	const title = current ? "Select IDE (toggle to disconnect)" : "Connect to IDE";
	const choice = await ui.select(title, labels);
	if (!choice) return { kind: "cancelled" };
	const lockfile = candidates[labels.indexOf(choice)];
	return lockfile ? { kind: "selected", lockfile } : { kind: "cancelled" };
}

/**
 * Find lockfiles that match the given cwd, have a live PID, and are listening.
 */
async function findCandidateLockfiles(cwd: string): Promise<Lockfile[]> {
	const all = await listLockfiles();
	const candidates: Lockfile[] = [];
	for (const lf of all) {
		if (!matchesCwd(lf, cwd)) continue;
		if (!isPidAlive(lf.pid)) continue;
		if (!(await isPortListening(lf.port))) continue;
		candidates.push(lf);
	}
	return candidates;
}

/**
 * Create an IdeClient, wire up handlers, and connect.
 */
async function connectToLockfile(lockfile: Lockfile, ctx: ExtensionContext, pi: ExtensionAPI): Promise<IdeClient | null> {
	const next = new IdeClient(lockfile);
	ui = ctx.ui;
	next.onNotification = onNotification;
	next.onRequest("getSuggestions", async (params, signal) => {
		inFlightSuggestions++;
		if (inFlightSuggestions === 1) startSpinner();
		renderWidget();
		try {
			const suggestions = await generateSuggestions(pi, (params ?? {}) as SuggestionParams, signal);
			return { suggestions };
		} finally {
			inFlightSuggestions--;
			if (inFlightSuggestions === 0) stopSpinner();
			renderWidget();
		}
	});
	next.onRequest("listSuggestionModels", async () => {
		if (!sessionCtx) throw new Error("session not yet started");
		const flagValue = pi.getFlag(SUGGESTION_FLAG);
		const cliOverride = (typeof flagValue === "string" && flagValue) ? flagValue : undefined;
		return {
			cliOverride,
			currentModel: sessionCtx.model ? `${sessionCtx.model.provider}/${sessionCtx.model.id}` : undefined,
			models: sessionCtx.modelRegistry.getAvailable().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				model: `${model.provider}/${model.id}`,
			})),
		};
	});
	next.onClose = () => {
		if (client === next) {
			client = null;
			resetState();
			inFlightSuggestions = 0;
			stopSpinner();
			renderWidget();
			ui?.notify("IDE disconnected", "warning");
		}
	};
	try {
		await next.connect();
	} catch (err) {
		ctx.ui.notify(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`, "error");
		return null;
	}
	client = next;
	setStickyLockfile(lockfile);
	renderWidget();
	return next;
}

/**
 * Auto-connect to an IDE.
 *
 * When `preferSticky` is true (session replacement flow), tries the sticky
 * IDE from the previous session first, bypassing the single-candidate rule.
 * Falls back to the cold-start rule when sticky is absent or stale.
 *
 * When `preferSticky` is false (cold startup), connects only when exactly one
 * valid IDE candidate exists for the cwd.
 */
async function autoConnect(ctx: ExtensionContext, pi: ExtensionAPI, options: { preferSticky: boolean }): Promise<void> {
	if (client?.isConnected()) return;
	if (!isAutoconnectEnabled(ctx.cwd)) return;

	let candidates = await findCandidateLockfiles(ctx.cwd);

	if (options.preferSticky) {
		const sticky = getStickyLockfile();
		if (sticky) {
			const candidate = candidates.find((c) => sameLockfile(c, sticky));
			if (candidate) {
				const connected = await connectToLockfile(candidate, ctx, pi);
				if (connected) {
					ctx.ui.notify(`Reconnected to ${candidate.ideName}`, "info");
					return;
				}
				// Treat a failed sticky reconnect as stale. Do not retry the
				// same lockfile in the cold-start fallback below.
				clearStickyLockfile();
				candidates = candidates.filter((c) => !sameLockfile(c, candidate));
			} else {
				// Sticky IDE is gone; clear it and fall through to cold start logic.
				clearStickyLockfile();
			}
		}
	}

	if (candidates.length !== 1) return;
	const lockfile = candidates[0];
	const connected = await connectToLockfile(lockfile, ctx, pi);
	if (connected) {
		ctx.ui.notify(`Auto-connected to ${lockfile.ideName}`, "info");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(SUGGESTION_FLAG, {
		type: "string",
		description: "Model to use for inline suggestions (format: provider/id). Falls back to current session model.",
	});
	pi.registerFlag(SUGGESTION_DEBUG_LOG_FLAG, {
		type: "string",
		description: "Path to append raw inline suggestion debug logs.",
	});

	pi.on("session_start", async (event, ctx) => {
		sessionCtx = ctx;
		if (event.reason === "startup") {
			await autoConnect(ctx, pi, { preferSticky: false });
		}
		if (event.reason === "new" || event.reason === "resume" || event.reason === "reload") {
			await autoConnect(ctx, pi, { preferSticky: true });
		}
	});

	pi.registerCommand("ide", {
		description: "Connect to a running IDE for ambient context and IDE-routed diffs. Select the current IDE to disconnect.",
		async handler(_args, ctx) {
			const wasConnected = client?.isConnected() ?? false;
			const currentLockfile = wasConnected ? client!.lockfile : undefined;
			const pick = await pickLockfile(ctx.cwd, ctx.ui, currentLockfile);
			if (pick.kind === "cancelled") return;

			if (wasConnected) {
				if (pick.kind === "none") {
					disconnectFromIde();
					ctx.ui.notify(`Disconnected from ${currentLockfile!.ideName}`, "warning");
					return;
				}
				const same =
					pick.lockfile.port === currentLockfile!.port &&
					pick.lockfile.pid === currentLockfile!.pid;
				if (same) {
					disconnectFromIde();
					ctx.ui.notify(`Disconnected from ${currentLockfile!.ideName}`, "warning");
					return;
				}
				// Switch to a different IDE
				disconnectFromIde();
			}

			if (pick.kind === "none") {
				ctx.ui.notify("No running IDE found for this project", "warning");
				return;
			}

			await connectToLockfile(pick.lockfile, ctx, pi);
		},
	});

	pi.on("context", async (event) => {
		const blocks: string[] = [];
		const editor = renderEditorBlock();
		if (editor) blocks.push(editor);
		const diagnostics = await fetchDiagnosticsBlock();
		if (diagnostics) blocks.push(diagnostics);
		if (blocks.length === 0) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "pi-ide.editor-context",
					content: blocks.join("\n\n"),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!client?.isConnected()) return;

		let path: string;
		let originalContent: string;
		let proposedContent: string;
		let applyResult: (text: string) => void;

		if (isToolCallEventType("write", event)) {
			const writeEvent = event;
			path = resolvePath(ctx.cwd, writeEvent.input.path);
			try {
				originalContent = await readFile(path, "utf-8");
			} catch {
				originalContent = "";
			}
			proposedContent = writeEvent.input.content;
			applyResult = (text) => {
				writeEvent.input.content = text;
			};
		} else if (isToolCallEventType("edit", event)) {
			const editEvent = event;
			path = resolvePath(ctx.cwd, editEvent.input.path);
			try {
				originalContent = await readFile(path, "utf-8");
			} catch {
				return;
			}
			try {
				proposedContent = applyEdits(originalContent, editEvent.input.edits);
			} catch (err) {
				ctx.ui.notify(
					`pi-ide: edit preview failed (${err instanceof Error ? err.message : String(err)})`,
					"warning",
				);
				return;
			}
			applyResult = (text) => {
				editEvent.input.edits = [{ oldText: originalContent, newText: text }];
			};
		} else {
			return;
		}

		const tabName = `pi-${event.toolName}:${event.toolCallId}`;
		let result: { content?: { text?: string }[] };
		try {
			result = await client.callTool("openDiff", {
				old_file_path: path,
				new_file_path: path,
				new_file_contents: proposedContent,
				tab_name: tabName,
			});
		} catch (err) {
			ctx.ui.notify(`IDE diff failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return;
		}
		void client.callTool("close_tab", { tab_name: tabName }).catch(() => {});
		const parsed = parseDiffResult(result);
		if (!parsed.saved) return { block: true, reason: `user rejected the ${event.toolName} in IDE` };
		applyResult(parsed.text);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		client?.close();
		inFlightSuggestions = 0;
		stopSpinner();
		renderWidget();
		client = null;
		resetState();
	});
}
