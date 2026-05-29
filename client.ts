import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export type Lockfile = {
	port: number;
	pid: number;
	workspaceFolders: string[];
	ideName: string;
	authToken: string;
};

export type McpContent = { type: "text"; text: string }[];
export type McpResult = { content: McpContent };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const AUTH_HEADER = "x-pi-ide-authorization";
const PROTOCOL_VERSION = "2024-11-05";

export function getLockDir(): string {
	return process.env.PI_IDE_LOCK_DIR ?? join(homedir(), ".pi", "ide");
}

export async function listLockfiles(): Promise<Lockfile[]> {
	const dir = getLockDir();
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: Lockfile[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const port = Number.parseInt(entry.slice(0, -5), 10);
		if (!Number.isFinite(port)) continue;
		try {
			const data = JSON.parse(await readFile(join(dir, entry), "utf-8"));
			if (typeof data.pid !== "number" || typeof data.authToken !== "string") continue;
			out.push({
				port,
				pid: data.pid,
				workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
				ideName: typeof data.ideName === "string" ? data.ideName : "unknown",
				authToken: data.authToken,
			});
		} catch {}
	}
	return out;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isPortListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

export function matchesCwd(lockfile: Lockfile, cwd: string): boolean {
	const norm = (p: string) => (p.endsWith("/") ? p : `${p}/`);
	const target = norm(cwd);
	return lockfile.workspaceFolders.some((f) => {
		const folder = norm(f);
		return target === folder || target.startsWith(folder);
	});
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type RequestHandler = (params: unknown, signal: AbortSignal) => Promise<unknown>;

export class IdeClient {
	private ws: WebSocket | null = null;
	private closed = false;
	public readonly lockfile: Lockfile;
	private pending = new Map<string, Pending>();
	private requestHandlers = new Map<string, RequestHandler>();
	private inboundAborts = new Map<string, AbortController>();
	// Ids that were cancelled before their handler started. Pruned on dispatch.
	// Capped so a server that emits stray cancels can't grow this without bound;
	// oldest entries are evicted first.
	private earlyCancels = new Set<string>();
	private static EARLY_CANCEL_CAP = 50;
	public onNotification: NotificationHandler = () => {};
	public onClose: () => void = () => {};

	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	constructor(lockfile: Lockfile) {
		this.lockfile = lockfile;
	}

	async connect(): Promise<void> {
		const ws = new WebSocket(`ws://127.0.0.1:${this.lockfile.port}/`, {
			headers: { [AUTH_HEADER]: this.lockfile.authToken },
		});
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", (err) => reject(err));
		});
		this.ws = ws;
		ws.on("message", (data) => this.handleMessage(data.toString()));
		ws.on("close", () => this.handleClose());
		ws.on("error", () => {});
		try {
			await this.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-ide", version: "0.1.0" },
			});
		} catch (err) {
			this.ws = null;
			try {
				ws.close();
			} catch {}
			throw err;
		}
	}

	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	close(): void {
		if (this.ws) {
			this.ws.close(1000);
			this.ws = null;
		}
		this.handleClose();
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("IDE not connected"));
		}
		const id = randomUUID();
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(payload, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
		return this.request("tools/call", { name, arguments: args }) as Promise<McpResult>;
	}

	private handleMessage(text: string): void {
		let msg: {
			id?: string | number;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { code: number; message: string };
		};
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		// Response to a request we sent: has id and no method.
		if (msg.id !== undefined && typeof msg.method !== "string") {
			const pending = this.pending.get(String(msg.id));
			if (!pending) return;
			this.pending.delete(String(msg.id));
			if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
			else pending.resolve(msg.result);
			return;
		}
		// Inbound request from server: has both id and method.
		if (msg.id !== undefined && typeof msg.method === "string") {
			void this.handleInboundRequest(msg.id, msg.method, msg.params);
			return;
		}
		if (typeof msg.method === "string") {
			if (msg.method === "request_cancelled") {
				const params = msg.params as { id?: string | number } | undefined;
				const id = params?.id;
				if (id !== undefined) {
					const key = String(id);
					const ac = this.inboundAborts.get(key);
					if (ac) {
						ac.abort();
					} else {
						if (this.earlyCancels.size >= IdeClient.EARLY_CANCEL_CAP) {
							const oldest = this.earlyCancels.values().next().value;
							if (oldest !== undefined) this.earlyCancels.delete(oldest);
						}
						this.earlyCancels.add(key);
					}
				}
				return;
			}
			this.onNotification(msg.method, msg.params);
		}
	}

	private async handleInboundRequest(id: string | number, method: string, params: unknown): Promise<void> {
		const key = String(id);
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.sendRaw({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${method}` },
			});
			return;
		}
		if (this.earlyCancels.delete(key)) {
			this.sendRaw({
				jsonrpc: "2.0",
				id,
				error: { code: -32800, message: "Request cancelled" },
			});
			return;
		}
		const ac = new AbortController();
		this.inboundAborts.set(key, ac);
		try {
			const result = await handler(params, ac.signal);
			this.sendRaw({ jsonrpc: "2.0", id, result });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code = ac.signal.aborted ? -32800 : -32603;
			this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
		} finally {
			this.inboundAborts.delete(key);
		}
	}

	private sendRaw(message: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(message));
	}

	private handleClose(): void {
		if (this.closed) return;
		this.closed = true;
		const err = new Error("IDE connection closed");
		for (const pending of this.pending.values()) pending.reject(err);
		this.pending.clear();
		for (const ac of this.inboundAborts.values()) ac.abort();
		this.inboundAborts.clear();
		this.ws = null;
		this.onClose();
	}
}
