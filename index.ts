import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { IdeClient, isPidAlive, isPortListening, listLockfiles, type Lockfile, matchesCwd } from "./client.ts";

type Selection = { startLine: number; endLine: number; text: string };
type EditorState = { filePath: string | null; cursorLine: number | null; selection: Selection | null };

const MAX_SELECTION_LINES = 100;
const WIDGET_KEY = "pi-ide";

let client: IdeClient | null = null;
let state: EditorState = { filePath: null, cursorLine: null, selection: null };
let ui: ExtensionUIContext | null = null;

function resetState(): void {
	state = { filePath: null, cursorLine: null, selection: null };
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
			next.onClose = () => {
				if (client === next) {
					client = null;
					resetState();
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
		renderWidget();
		client = null;
		resetState();
	});
}
