import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { IdeClient, isPidAlive, isPortListening, listLockfiles, type Lockfile, matchesCwd } from "./client.ts";

const SUGGESTION_FLAG = "pi-ide-suggestion-model";
const SUGGESTION_SYSTEM_PROMPT = `You are an inline code completion engine. Output up to N alternative completions for what should appear at the cursor position. Each must be wrapped in <SUGGESTION>...</SUGGESTION> tags. Order most-likely first.

Rules:
1. Output ONLY the code to insert. Do not repeat code before or after the cursor.
2. Match the file's existing indentation, naming, and style.
3. Stop at a natural unit boundary.
4. If mid-token, complete that token first.
5. If you have only one strong completion, output one block.
6. If nothing reasonable, output zero blocks.`;

type Selection = { startLine: number; endLine: number; text: string };
type EditorState = { filePath: string | null; cursorLine: number | null; selection: Selection | null };

const MAX_SELECTION_LINES = 100;
const WIDGET_KEY = "pi-ide";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

let client: IdeClient | null = null;
let state: EditorState = { filePath: null, cursorLine: null, selection: null };
let ui: ExtensionUIContext | null = null;
let sessionCtx: ExtensionContext | null = null;
let inFlightSuggestions = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

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

type SuggestionParams = {
	filePath?: string;
	language?: string;
	outline?: string;
	enclosingScope?: string;
	cursorBefore?: string;
	cursorAfter?: string;
	suggestionCount?: number;
	// Editor-provided model preference, format "provider/id". The CLI flag
	// (--pi-ide-suggestion-model) wins when both are set.
	model?: string;
};

function buildSuggestionPrompt(params: SuggestionParams): string {
	const filePath = params.filePath ?? "<unknown>";
	const language = params.language ?? "<unknown>";
	const outline = params.outline?.trim() ? params.outline : "(none)";
	const enclosing = params.enclosingScope?.trim() ? params.enclosingScope : "(none)";
	const before = params.cursorBefore ?? "";
	const after = params.cursorAfter ?? "";
	const count = params.suggestionCount ?? 3;
	return `File: ${filePath}
Language: ${language}

<file_outline>
${outline}
</file_outline>

<enclosing_scope>
${enclosing}
</enclosing_scope>

<cursor_context>
${before}<CURSOR>${after}
</cursor_context>

Provide up to ${count} suggestions.`;
}

function parseSuggestionBlocks(text: string): string[] {
	const out: string[] = [];
	const re = /<SUGGESTION>([\s\S]*?)<\/SUGGESTION>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.push(m[1]);
	}
	if (out.length === 0) {
		// Salvage an unclosed trailing <SUGGESTION> when the LLM hit maxTokens
		// before emitting the closing tag.
		const open = text.lastIndexOf("<SUGGESTION>");
		if (open !== -1 && text.indexOf("</SUGGESTION>", open) === -1) {
			const tail = text.slice(open + "<SUGGESTION>".length).trimEnd();
			if (tail) out.push(tail);
		}
	}
	return out;
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
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	const blocks = parseSuggestionBlocks(text);
	const max = params.suggestionCount ?? 3;
	return blocks.slice(0, max);
}

type PickResult =
	| { kind: "selected"; lockfile: Lockfile }
	| { kind: "none" }
	| { kind: "cancelled" };

async function pickLockfile(cwd: string, ui: { select: (t: string, o: string[]) => Promise<string | undefined> }): Promise<PickResult> {
	const all = await listLockfiles();
	const candidates: Lockfile[] = [];
	for (const lf of all) {
		if (!matchesCwd(lf, cwd)) continue;
		if (!isPidAlive(lf.pid)) continue;
		if (!(await isPortListening(lf.port))) continue;
		candidates.push(lf);
	}
	if (candidates.length === 0) return { kind: "none" };
	const labels = candidates.map((c) => {
		const folder = c.workspaceFolders[0] ?? "?";
		return `${c.ideName} · ${folder} · pid=${c.pid} port=${c.port}`;
	});
	const choice = await ui.select("Connect to IDE", labels);
	if (!choice) return { kind: "cancelled" };
	const lockfile = candidates[labels.indexOf(choice)];
	return lockfile ? { kind: "selected", lockfile } : { kind: "cancelled" };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(SUGGESTION_FLAG, {
		type: "string",
		description: "Model to use for inline suggestions (format: provider/id). Falls back to current session model.",
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
	});

	pi.registerCommand("ide", {
		description: "Connect to a running IDE for ambient context and IDE-routed diffs.",
		async handler(_args, ctx) {
			if (client?.isConnected()) {
				ctx.ui.notify(`Already connected to ${client.lockfile.ideName} (port ${client.lockfile.port})`);
				return;
			}
			const pick = await pickLockfile(ctx.cwd, ctx.ui);
			if (pick.kind === "none") {
				ctx.ui.notify("No running IDE found for this project", "warning");
				return;
			}
			if (pick.kind === "cancelled") return;
			const next = new IdeClient(pick.lockfile);
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
			next.onClose = () => {
				if (client === next) {
					client = null;
					resetState();
					inFlightSuggestions = 0;
					stopSpinner();
					renderWidget();
					ctx.ui.notify("IDE disconnected", "warning");
				}
			};
			try {
				await next.connect();
			} catch (err) {
				ctx.ui.notify(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			client = next;
			ui = ctx.ui;
			renderWidget();
		},
	});

	pi.on("before_agent_start", async (event) => {
		const blocks: string[] = [];
		const editor = renderEditorBlock();
		if (editor) blocks.push(editor);
		const diagnostics = await fetchDiagnosticsBlock();
		if (diagnostics) blocks.push(diagnostics);
		if (blocks.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
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
