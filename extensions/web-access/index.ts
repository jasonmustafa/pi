import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_FRAMES = 12;
const DEFAULT_CACHE_DIR = join(homedir(), ".pi", "agent", "web-cache");

function resolveCacheDir(): string {
	const configured = process.env.PI_WEB_ACCESS_CACHE_DIR?.trim()
		|| process.env.CLANK_WEB_ACCESS_CACHE_DIR?.trim();
	if (configured) return resolve(configured);

	const clankWorkspaceRoot = process.env.CLANK_WORKSPACE_ROOT?.trim();
	if (clankWorkspaceRoot) return resolve(clankWorkspaceRoot, ".web-cache");

	return DEFAULT_CACHE_DIR;
}

const CACHE_DIR = resolveCacheDir();
const ENABLE_JINA_READER = /^(1|true|yes)$/i.test(process.env.PI_WEB_ACCESS_ENABLE_JINA_READER ?? "");

function preferredCommand(name: string): string {
	const local = join(homedir(), ".local", "bin", name);
	return existsSync(local) ? local : name;
}

const GIT = preferredCommand("git");
const YT_DLP = preferredCommand("yt-dlp");
const FFMPEG = preferredCommand("ffmpeg");

interface OpenAIAuth {
	provider: "openai-codex" | "openai";
	apiKey: string;
	model: string;
	headers: Record<string, string>;
}

interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

interface SearchResponse {
	answer: string;
	results: SearchResult[];
	provider: string;
	model: string;
}

interface TextResultDetails {
	type: string;
	url?: string;
	title?: string;
	localPath?: string;
	contentLength?: number;
	fullContentPath?: string;
	truncation?: TruncationResult;
	[key: string]: unknown;
}

interface ContentItemResult {
	text: string;
	details: TextResultDetails;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

interface PublicHttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function runText(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(command, args, {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? 30_000,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
		signal: options.signal,
	});
	return { stdout: result.stdout as string, stderr: result.stderr as string };
}

function runBuffer(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(command, args, {
			cwd: options.cwd,
			timeout: options.timeoutMs ?? 30_000,
			encoding: "buffer",
			maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolvePromise({ stdout: stdout as Buffer, stderr: stderr as Buffer });
		});
		if (options.signal) {
			if (options.signal.aborted) child.kill("SIGTERM");
			else options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		}
	});
}

async function commandExists(command: string, args = ["--version"]): Promise<boolean> {
	try {
		await runText(command, args, { timeoutMs: 5_000, maxBuffer: 1024 * 1024 });
		return true;
	} catch {
		return false;
	}
}

async function writeFullText(prefix: string, content: string): Promise<string> {
	const root = join(CACHE_DIR, "full-content");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, `pi-${prefix}-`));
	const file = join(dir, "content.md");
	await writeFile(file, content, "utf8");
	return file;
}

async function makeTextResult(
	type: string,
	title: string,
	content: string,
	details: Omit<TextResultDetails, "type" | "title" | "contentLength" | "fullContentPath" | "truncation"> = {},
): Promise<ContentItemResult> {
	const header = title ? `# ${title}\n\n` : "";
	const full = header + content.trim();
	const truncation = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let text = truncation.content;
	const resultDetails: TextResultDetails = {
		type,
		title,
		contentLength: full.length,
		...details,
	};
	if (truncation.truncated) {
		const fullContentPath = await writeFullText(type.replace(/[^a-z0-9_-]/gi, "-"), full);
		resultDetails.fullContentPath = fullContentPath;
		resultDetails.truncation = truncation;
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		text += ` Full content saved to: ${fullContentPath}]`;
	}
	return { text, details: resultDetails };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function isCodexJwt(token: string): boolean {
	const payload = decodeJwtPayload(token);
	return !!payload?.["https://api.openai.com/auth"];
}

function extractAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const id = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

async function authFromModel(ctx: ExtensionContext, model: any): Promise<OpenAIAuth | undefined> {
	if (!model || (model.provider !== "openai-codex" && model.provider !== "openai")) return undefined;
	try {
		const resolved = await (ctx.modelRegistry as any).getApiKeyAndHeaders(model);
		if (resolved?.ok && resolved.apiKey) {
			return {
				provider: model.provider,
				apiKey: resolved.apiKey,
				model: model.id,
				headers: resolved.headers ?? {},
			};
		}
	} catch {
		// Try the next candidate.
	}
	return undefined;
}

async function resolveOpenAIAuth(ctx?: ExtensionContext): Promise<OpenAIAuth | undefined> {
	if (ctx?.model) {
		const current = await authFromModel(ctx, ctx.model);
		if (current) return current;
	}

	if (ctx) {
		const candidates = [
			{ provider: "openai-codex", models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] },
			{ provider: "openai", models: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-4.1-mini", "gpt-4o"] },
		] as const;
		for (const candidate of candidates) {
			for (const modelId of candidate.models) {
				const model = getModel(candidate.provider, modelId);
				const auth = await authFromModel(ctx, model);
				if (auth) return auth;
			}
		}
	}

	const apiKey = process.env.OPENAI_API_KEY?.trim();
	return apiKey ? { provider: "openai", apiKey, model: process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-4.1-mini", headers: {} } : undefined;
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(domainFilter: string[] | undefined): { allowedDomains?: string[]; blockedDomains?: string[] } | null {
	if (!domainFilter?.length) return null;
	const allowedDomains: string[] = [];
	const blockedDomains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
		if (!target.includes(domain)) target.push(domain);
	}
	return allowedDomains.length > 0 || blockedDomains.length > 0
		? {
			...(allowedDomains.length > 0 ? { allowedDomains: allowedDomains.slice(0, 100) } : {}),
			...(blockedDomains.length > 0 ? { blockedDomains: blockedDomains.slice(0, 100) } : {}),
		}
		: null;
}

function buildSearchInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise answer grounded only in web results.",
		"Include source citations in the response text when possible.",
	];
	if (options.recencyFilter) {
		const labels: Record<string, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters?.allowedDomains?.length) lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
	if (filters?.blockedDomains?.length) lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);
	return lines.join(" ");
}

function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
	const tool: Record<string, unknown> = { type: "web_search" };
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters) {
		tool.filters = {
			...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
			...(filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
		};
	}
	return tool;
}

async function parseOpenAIResponse(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return { output: parsed };
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { output: [] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`OpenAI API returned invalid JSON: ${message}`);
		}
	}

	const outputItems: unknown[] = [];
	let completedResponse: Record<string, unknown> | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			if (parsed.type === "response.output_item.done" && parsed.item) outputItems.push(parsed.item);
			if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response && typeof parsed.response === "object") {
				completedResponse = parsed.response as Record<string, unknown>;
			}
		} catch {
			// Ignore non-JSON stream lines.
		}
	}
	if (completedResponse) {
		const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
		return output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
	}
	if (outputItems.length > 0) return { output: outputItems };
	throw new Error("OpenAI API returned no parseable response output");
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/, "");
	}
}

function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
	if (typeof url !== "string" || url.trim().length === 0) return;
	const cleanUrl = cleanSourceUrl(url);
	if (seen.has(cleanUrl)) return;
	seen.add(cleanUrl);
	results.push({
		title: typeof title === "string" && title.trim().length > 0 ? title : cleanUrl,
		url: cleanUrl,
		snippet,
	});
}

function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			const annotations = (part as { annotations?: unknown }).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
				addResult(
					results,
					seenUrls,
					(annotation as { url?: unknown }).url,
					(annotation as { title?: unknown }).title,
					extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
				);
			}
		}
	}
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources = value.action && typeof value.action === "object"
			? (value.action as { sources?: unknown }).sources
			: undefined;
		const sourceGroups = [actionSources, value.sources, value.results];
		for (const group of sourceGroups) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!source || typeof source !== "object") continue;
				const record = source as Record<string, unknown>;
				addResult(results, seenUrls, record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	}
	if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), 20));
	}
	return results;
}

function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

async function searchWithOpenAI(query: string, options: SearchOptions, ctx?: ExtensionContext): Promise<SearchResponse> {
	const auth = await resolveOpenAIAuth(ctx);
	if (!auth) {
		throw new Error("OpenAI web search unavailable. Sign in with /login to OpenAI Codex or set OPENAI_API_KEY.");
	}

	const headers: Record<string, string> = {
		...auth.headers,
		Authorization: `Bearer ${auth.apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};
	const useCodexEndpoint = auth.provider === "openai-codex" || isCodexJwt(auth.apiKey);
	if (useCodexEndpoint) {
		const accountId = extractAccountId(auth.apiKey);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		headers.originator = "pi";
	}

	const body = {
		model: auth.model,
		instructions: buildSearchInstructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [buildWebSearchTool(options)],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required" as const,
		parallel_tool_calls: true,
	};

	const response = await fetch(useCodexEndpoint ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: combinedSignal(options.signal, SEARCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
	}
	const parsed = await parseOpenAIResponse(response);
	const output = Array.isArray(parsed.output) ? parsed.output : [];
	const answer = extractAnswer(output);
	const results = extractSearchResults(output, options.numResults);
	if (!answer && results.length === 0) throw new Error("OpenAI web_search returned no answer or sources");
	return { answer, results, provider: auth.provider, model: auth.model };
}

function formatSearchResult(query: string, response: SearchResponse): string {
	let text = `## Search: ${query}\n\n`;
	if (response.answer) text += `${response.answer}\n\n`;
	if (response.results.length > 0) {
		text += "### Sources\n";
		text += response.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
	}
	return text.trim();
}

function isPrivateIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	return a === 0 || a === 10 || a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 2) ||
		(a === 198 && (b === 18 || b === 19 || b === 51)) ||
		(a === 203 && b === 0) ||
		a >= 224;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (normalized.startsWith("2001:db8:")) return true;
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isPrivateIPv4(mapped[1]);
	return false;
}

function isBlockedAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isPrivateIPv4(address);
	if (version === 6) return isPrivateIPv6(address);
	return true;
}

async function resolvePublicHttpUrl(rawUrl: string | URL): Promise<{ url: URL; address: string; family: 4 | 6 }> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
		throw new Error(`Blocked private/reserved host: ${url.hostname}`);
	}
	if (isIP(host) && isBlockedAddress(host)) throw new Error(`Blocked private/reserved address: ${host}`);
	const records = await dns.lookup(host, { all: true, verbatim: true });
	if (records.length === 0) throw new Error(`DNS lookup returned no addresses for ${host}`);
	for (const record of records) {
		if (isBlockedAddress(record.address)) throw new Error(`Blocked private/reserved address for ${host}: ${record.address}`);
	}
	const first = records[0];
	if (first.family !== 4 && first.family !== 6) throw new Error(`Unsupported DNS address family for ${host}: ${first.family}`);
	return { url, address: first.address, family: first.family };
}

async function validatePublicHttpUrl(rawUrl: string | URL): Promise<URL> {
	return (await resolvePublicHttpUrl(rawUrl)).url;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
	return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function headerGetter(headers: Record<string, string | string[] | undefined>): { get(name: string): string | null } {
	return {
		get(name: string): string | null {
			const value = headers[name.toLowerCase()];
			if (Array.isArray(value)) return value.join(", ");
			return value ?? null;
		},
	};
}

async function requestPinnedPublicHttpUrl(url: URL, address: string, family: 4 | 6, init: RequestInit, signal?: AbortSignal): Promise<PublicHttpResponse> {
	return new Promise((resolvePromise, reject) => {
		const request = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = request({
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || undefined,
			path: `${url.pathname}${url.search}`,
			method: init.method ?? "GET",
			headers: normalizeRequestHeaders(init.headers),
			servername: url.hostname,
			lookup: (_hostname, _options, callback) => callback(null, address, family),
		}, res => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			res.on("data", chunk => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > MAX_FETCH_BYTES) {
					req.destroy(new Error(`Response too large (${formatSize(bytes)})`));
					return;
				}
				chunks.push(buffer);
			});
			res.on("end", () => {
				const status = res.statusCode ?? 0;
				const body = Buffer.concat(chunks).toString("utf8");
				resolvePromise({
					ok: status >= 200 && status < 300,
					status,
					statusText: res.statusMessage ?? "",
					headers: headerGetter(res.headers),
					text: async () => body,
				});
			});
		});
		req.on("error", reject);
		req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`)));
		if (signal) {
			if (signal.aborted) req.destroy(new Error("Request aborted"));
			else signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")), { once: true });
		}
		req.end();
	});
}

async function fetchPublicHttpUrl(rawUrl: string | URL, init: RequestInit = {}, signal?: AbortSignal): Promise<{ response: PublicHttpResponse; url: URL }> {
	let url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		// Validate DNS immediately before every request and pin the socket to that
		// validated address, then handle redirects manually to avoid SSRF pivots.
		const resolved = await resolvePublicHttpUrl(url);
		url = resolved.url;
		const response = await requestPinnedPublicHttpUrl(url, resolved.address, resolved.family, init, signal);
		if (!isRedirectStatus(response.status)) return { response, url };
		const location = response.headers.get("location");
		if (!location) return { response, url };
		if (redirectCount === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
		url = new URL(location, url);
	}
	throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

function shouldSkipThirdPartyReader(rawUrl: string | URL): boolean {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.username || url.password || url.search || url.hash) return true;
	return false;
}

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
		const e = String(entity).toLowerCase();
		if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
		if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
		return named[e] ?? `&${entity};`;
	});
}

function extractHtmlTitle(html: string, fallback: string): string {
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	if (title) return decodeHtmlEntities(title.replace(/\s+/g, " ").trim());
	const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	if (heading) return decodeHtmlEntities(heading.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
	return fallback;
}

function htmlToText(html: string): { title: string; content: string } {
	const title = extractHtmlTitle(html, "Web page");
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "\n")
		.replace(/<style[\s\S]*?<\/style>/gi, "\n")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|main|nav|aside|li|ul|ol|blockquote|pre|table|tr|h[1-6])>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<h1[^>]*>/gi, "\n# ")
		.replace(/<h2[^>]*>/gi, "\n## ")
		.replace(/<h3[^>]*>/gi, "\n### ")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, " ");
	text = decodeHtmlEntities(text)
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, content: text };
}

async function fetchJinaReader(url: string, signal?: AbortSignal): Promise<ContentItemResult | null> {
	try {
		if (!ENABLE_JINA_READER) return null;
		const targetUrl = await validatePublicHttpUrl(url);
		if (shouldSkipThirdPartyReader(targetUrl)) return null;
		const { response } = await fetchPublicHttpUrl(`https://r.jina.ai/${targetUrl.toString()}`, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
		}, signal);
		if (!response.ok) return null;
		const raw = await response.text();
		const marker = raw.indexOf("Markdown Content:");
		const markdown = marker >= 0 ? raw.slice(marker + "Markdown Content:".length).trim() : raw.trim();
		if (markdown.length < 100) return null;
		const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || targetUrl.hostname;
		return makeTextResult("url", title, markdown, { url: targetUrl.toString(), extraction: "jina-reader" });
	} catch {
		return null;
	}
}

async function fetchHttpContent(rawUrl: string, signal?: AbortSignal): Promise<ContentItemResult> {
	const { response, url } = await fetchPublicHttpUrl(rawUrl, {
		headers: {
			"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36 pi-web-access-lite",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5",
			"Accept-Language": "en-US,en;q=0.9",
		},
	}, signal);
	if (!response.ok) {
		const jina = await fetchJinaReader(url.toString(), signal);
		if (jina) return jina;
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > MAX_FETCH_BYTES) throw new Error(`Response too large (${formatSize(Number(contentLength))})`);
	const contentType = response.headers.get("content-type") || "";
	if (/\b(image|audio|video)\//i.test(contentType) || /application\/(zip|octet-stream)/i.test(contentType)) {
		throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
	}
	const text = await response.text();
	if (text.length > MAX_FETCH_BYTES) throw new Error(`Response too large (${formatSize(text.length)})`);

	if (/text\/html|application\/xhtml\+xml/i.test(contentType) || /<html[\s>]/i.test(text)) {
		const extracted = htmlToText(text);
		if (extracted.content.length < 500) {
			const jina = await fetchJinaReader(url.toString(), signal);
			if (jina) return jina;
		}
		return makeTextResult("url", extracted.title || url.hostname, extracted.content, { url: url.toString(), contentType, extraction: "html" });
	}
	const title = basename(url.pathname) || url.hostname;
	return makeTextResult("url", title, text, { url: url.toString(), contentType, extraction: "text" });
}

interface GitHubInfo {
	owner: string;
	repo: string;
	kind: "repo" | "tree" | "blob" | "commit";
	ref?: string;
	subpath?: string;
	rest?: string[];
	originalUrl: string;
}

function parseGitHubUrl(raw: string): GitHubInfo | null {
	let url: URL;
	try { url = new URL(raw); } catch { return null; }
	if (url.hostname.toLowerCase() !== "github.com") return null;
	const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (segments.length < 2) return null;
	const [owner, rawRepo] = segments;
	const repo = rawRepo.replace(/\.git$/i, "");
	if (!owner || !repo) return null;
	const third = segments[2];
	if (!third) return { owner, repo, kind: "repo", originalUrl: raw };
	if (third === "tree" || third === "blob") {
		const rest = segments.slice(3);
		return { owner, repo, kind: third, ref: rest[0], subpath: rest.slice(1).join("/"), rest, originalUrl: raw };
	}
	if (third === "commit" && segments[3]) return { owner, repo, kind: "commit", ref: segments[3], originalUrl: raw };
	return null;
}

function repoCacheDir(info: GitHubInfo): string {
	return join(CACHE_DIR, "github", `${info.owner}__${info.repo}`.replace(/[^a-z0-9_.-]/gi, "_"));
}

async function cloneOrUpdateGitHub(info: GitHubInfo, signal?: AbortSignal): Promise<{ path: string; notes: string[] }> {
	const target = repoCacheDir(info);
	const notes: string[] = [];
	await mkdir(join(CACHE_DIR, "github"), { recursive: true });
	if (!existsSync(join(target, ".git"))) {
		await runText(GIT, ["clone", "--depth", "1", `https://github.com/${info.owner}/${info.repo}.git`, target], {
			timeoutMs: 120_000,
			signal,
			maxBuffer: 10 * 1024 * 1024,
		});
		notes.push("cloned");
	} else {
		try {
			await runText(GIT, ["-C", target, "fetch", "--depth", "1", "--prune"], { timeoutMs: 60_000, signal });
			await runText(GIT, ["-C", target, "pull", "--ff-only"], { timeoutMs: 60_000, signal });
			notes.push("updated existing clone");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			notes.push(`using existing clone; update failed: ${message.slice(0, 200)}`);
		}
	}
	if (info.ref && (info.kind === "tree" || info.kind === "blob" || info.kind === "commit")) {
		try {
			await runText(GIT, ["-C", target, "checkout", "--force", info.ref], { timeoutMs: 60_000, signal });
			notes.push(`checked out ${info.ref}`);
		} catch {
			notes.push(`could not checkout ref '${info.ref}', using current checkout`);
		}
	}
	return { path: target, notes };
}

async function resolveGitHubTarget(repoDir: string, info: GitHubInfo): Promise<{ localPath: string; subpath?: string }> {
	if (!info.rest || info.rest.length <= 1) return { localPath: repoDir, subpath: undefined };
	const fallback = info.rest.slice(1).join("/");
	for (let i = 1; i < info.rest.length; i++) {
		const candidate = info.rest.slice(i).join("/");
		const full = join(repoDir, candidate);
		if (!existsSync(full)) continue;
		const s = await stat(full);
		if ((info.kind === "blob" && s.isFile()) || (info.kind === "tree" && s.isDirectory())) {
			return { localPath: full, subpath: candidate };
		}
	}
	return { localPath: join(repoDir, fallback), subpath: fallback };
}

async function walkFiles(root: string, maxEntries = 220, maxDepth = 3): Promise<string[]> {
	const entries: string[] = [];
	async function walk(dir: string, rel: string, depth: number): Promise<void> {
		if (entries.length >= maxEntries || depth > maxDepth) return;
		let children: string[];
		try { children = await readdir(dir); } catch { return; }
		children.sort((a, b) => a.localeCompare(b));
		for (const child of children) {
			if (entries.length >= maxEntries) return;
			if ([".git", "node_modules", ".next", "dist", "build", "target"].includes(child)) continue;
			const full = join(dir, child);
			const childRel = rel ? `${rel}/${child}` : child;
			let s;
			try { s = await stat(full); } catch { continue; }
			entries.push(s.isDirectory() ? `${childRel}/` : childRel);
			if (s.isDirectory()) await walk(full, childRel, depth + 1);
		}
	}
	await walk(root, "", 0);
	return entries;
}

async function findReadme(dir: string): Promise<string | null> {
	let children: string[];
	try { children = await readdir(dir); } catch { return null; }
	const readme = children.find(name => /^readme(\.(md|markdown|txt|rst))?$/i.test(name));
	return readme ? join(dir, readme) : null;
}

async function extractGitHubContent(info: GitHubInfo, signal?: AbortSignal): Promise<ContentItemResult> {
	const { path: repoDir, notes } = await cloneOrUpdateGitHub(info, signal);
	let head = "unknown";
	try { head = (await runText(GIT, ["-C", repoDir, "rev-parse", "--short", "HEAD"], { timeoutMs: 5_000 })).stdout.trim(); } catch {}

	const target = await resolveGitHubTarget(repoDir, info);
	if (info.kind === "blob") {
		if (!existsSync(target.localPath)) {
			throw new Error(`GitHub file path not found after cloning: ${target.subpath ?? info.subpath ?? "(unknown)"}. Repo clone is at ${repoDir}`);
		}
		const content = await readFile(target.localPath, "utf8");
		return makeTextResult("github", `${info.owner}/${info.repo}: ${target.subpath ?? basename(target.localPath)}`, content, {
			url: info.originalUrl,
			localPath: target.localPath,
			repoPath: repoDir,
			head,
			notes,
		});
	}

	const dir = existsSync(target.localPath) ? target.localPath : repoDir;
	const listing = await walkFiles(dir);
	let content = `Repository cloned to: ${repoDir}\nHEAD: ${head}\nNotes: ${notes.join("; ") || "none"}\n`;
	if (dir !== repoDir) content += `Selected path: ${dir}\n`;
	content += `\n## File tree (truncated)\n\n${listing.map(e => `- ${e}`).join("\n")}`;
	const readme = await findReadme(dir === repoDir ? repoDir : dir);
	if (readme) {
		try {
			const readmeText = await readFile(readme, "utf8");
			content += `\n\n## ${basename(readme)}\n\n${readmeText.slice(0, 30_000)}`;
		} catch {}
	}
	return makeTextResult("github", `${info.owner}/${info.repo}`, content, {
		url: info.originalUrl,
		localPath: dir,
		repoPath: repoDir,
		head,
		notes,
	});
}

const YOUTUBE_REGEX = /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function isYouTubeUrl(url: string): { isYouTube: boolean; videoId?: string } {
	const match = url.match(YOUTUBE_REGEX);
	return match ? { isYouTube: true, videoId: match[1] } : { isYouTube: false };
}

function formatSeconds(total: number): string {
	const seconds = Math.max(0, Math.floor(total));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimestamp(value: string): number | null {
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
	const parts = value.split(":").map(Number);
	if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

function computeFrameTimestamps(timestamp: string | undefined, frameCount: number | undefined, duration: number | null): { label: string; timestamps: number[] } {
	const count = Math.max(1, Math.min(Math.floor(frameCount ?? 1), MAX_FRAMES));
	if (!timestamp) {
		if (!duration || duration <= 0) return { label: "0:00", timestamps: [0] };
		if (count === 1) return { label: "0:00", timestamps: [0] };
		return {
			label: `0:00-${formatSeconds(duration)}`,
			timestamps: Array.from({ length: count }, (_, i) => Math.round((duration * i) / (count - 1))),
		};
	}
	const dash = timestamp.indexOf("-", 1);
	if (dash > 0) {
		const start = parseTimestamp(timestamp.slice(0, dash));
		const end = parseTimestamp(timestamp.slice(dash + 1));
		if (start === null || end === null || end <= start) throw new Error(`Invalid timestamp range: ${timestamp}`);
		if (count === 1) return { label: `${formatSeconds(start)}-${formatSeconds(end)}`, timestamps: [start] };
		return {
			label: `${formatSeconds(start)}-${formatSeconds(end)}`,
			timestamps: Array.from({ length: count }, (_, i) => Math.round(start + ((end - start) * i) / (count - 1))),
		};
	}
	const start = parseTimestamp(timestamp);
	if (start === null) throw new Error(`Invalid timestamp: ${timestamp}`);
	if (count === 1) return { label: formatSeconds(start), timestamps: [start] };
	return {
		label: `${formatSeconds(start)}-${formatSeconds(start + (count - 1) * 5)}`,
		timestamps: Array.from({ length: count }, (_, i) => start + i * 5),
	};
}

function cleanCaptionText(text: string): string {
	return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseJson3Captions(raw: string): string {
	const parsed = JSON.parse(raw);
	const events = Array.isArray(parsed.events) ? parsed.events : [];
	const lines: string[] = [];
	for (const event of events) {
		if (!event || typeof event !== "object" || !Array.isArray(event.segs)) continue;
		const text = cleanCaptionText(event.segs.map((seg: any) => typeof seg?.utf8 === "string" ? seg.utf8 : "").join(""));
		if (!text) continue;
		const seconds = typeof event.tStartMs === "number" ? event.tStartMs / 1000 : 0;
		lines.push(`[${formatSeconds(seconds)}] ${text}`);
	}
	return lines.join("\n");
}

function parseVttCaptions(raw: string): string {
	const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
	const lines: string[] = [];
	for (const block of blocks) {
		const blockLines = block.split("\n").map(l => l.trim()).filter(Boolean);
		const timeLine = blockLines.find(l => l.includes("-->"));
		if (!timeLine) continue;
		const start = timeLine.split("-->")[0].trim().split(".")[0].replace(/^00:/, "");
		const text = cleanCaptionText(blockLines.slice(blockLines.indexOf(timeLine) + 1).join(" "));
		if (text) lines.push(`[${start}] ${text}`);
	}
	return lines.join("\n");
}

function chooseCaptionTrack(metadata: any): { url: string; ext?: string; language: string; automatic: boolean } | null {
	const pools: Array<{ source: any; automatic: boolean }> = [
		{ source: metadata?.subtitles, automatic: false },
		{ source: metadata?.automatic_captions, automatic: true },
	];
	for (const { source, automatic } of pools) {
		if (!source || typeof source !== "object") continue;
		const keys = Object.keys(source);
		const preferred = ["en", "en-US", "en-GB", ...keys.filter(k => /^en[-_]/i.test(k)), ...keys];
		for (const lang of preferred) {
			const tracks = source[lang];
			if (!Array.isArray(tracks)) continue;
			const track = tracks.find((t: any) => t?.url && t.ext === "json3")
				?? tracks.find((t: any) => t?.url && t.ext === "vtt")
				?? tracks.find((t: any) => t?.url);
			if (track?.url) return { url: track.url, ext: track.ext, language: lang, automatic };
		}
	}
	return null;
}

async function fetchTranscriptFromMetadata(metadata: any, signal?: AbortSignal): Promise<{ transcript: string; language?: string; automatic?: boolean } | null> {
	const track = chooseCaptionTrack(metadata);
	if (!track) return null;
	const { response } = await fetchPublicHttpUrl(track.url, {}, signal);
	if (!response.ok) return null;
	const raw = await response.text();
	let transcript = "";
	try {
		if (track.ext === "json3" || raw.trim().startsWith("{")) transcript = parseJson3Captions(raw);
		else transcript = parseVttCaptions(raw);
	} catch {
		transcript = parseVttCaptions(raw);
	}
	return transcript ? { transcript, language: track.language, automatic: track.automatic } : null;
}

async function getYouTubeMetadata(url: string, signal?: AbortSignal): Promise<any | null> {
	if (!await commandExists(YT_DLP)) return null;
	const { stdout } = await runText(YT_DLP, ["--dump-json", "--no-playlist", "--no-warnings", url], {
		timeoutMs: 45_000,
		signal,
		maxBuffer: 25 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

async function getYouTubeStream(url: string, signal?: AbortSignal): Promise<{ streamUrl: string; duration: number | null }> {
	if (!await commandExists(YT_DLP)) throw new Error("yt-dlp is not installed. Install it to extract YouTube frames.");
	const { stdout } = await runText(YT_DLP, ["--no-playlist", "-f", "best[ext=mp4]/best", "--print", "duration", "-g", url], {
		timeoutMs: 45_000,
		signal,
		maxBuffer: 5 * 1024 * 1024,
	});
	const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const duration = Number.parseFloat(lines[0] ?? "");
	const streamUrl = lines.find(l => /^https?:\/\//.test(l));
	if (!streamUrl) throw new Error("yt-dlp did not return a stream URL");
	return { streamUrl, duration: Number.isFinite(duration) ? duration : null };
}

async function extractFrame(streamUrl: string, seconds: number, signal?: AbortSignal): Promise<{ data: string; mimeType: string }> {
	if (!await commandExists(FFMPEG, ["-version"])) throw new Error("ffmpeg is not installed. Install it to extract video frames.");
	const { stdout } = await runBuffer(FFMPEG, [
		"-ss", String(seconds), "-i", streamUrl,
		"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
	], { timeoutMs: 30_000, signal, maxBuffer: 8 * 1024 * 1024 });
	if (stdout.length === 0) throw new Error("ffmpeg returned an empty frame");
	return { data: stdout.toString("base64"), mimeType: "image/jpeg" };
}

async function extractYouTubeFramesContent(url: string, timestamp: string | undefined, frames: number | undefined, signal?: AbortSignal): Promise<ContentItemResult> {
	const stream = await getYouTubeStream(url, signal);
	const frameSpec = computeFrameTimestamps(timestamp, frames ?? (timestamp?.includes("-") ? 6 : 1), stream.duration);
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	const lines: string[] = [];
	for (const seconds of frameSpec.timestamps.slice(0, MAX_FRAMES)) {
		const frame = await extractFrame(stream.streamUrl, seconds, signal);
		images.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
		lines.push(`- ${formatSeconds(seconds)}`);
	}
	return {
		text: `# YouTube frames\n\nExtracted ${images.length} frame(s) from ${url}.\nRange: ${frameSpec.label}\n\nTimestamps:\n${lines.join("\n")}`,
		details: { type: "youtube-frames", url, title: "YouTube frames", frameCount: images.length, timestamps: frameSpec.timestamps.map(formatSeconds), duration: stream.duration },
		images,
	};
}

async function extractYouTubeContent(url: string, prompt: string | undefined, timestamp: string | undefined, frames: number | undefined, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ContentItemResult> {
	if (timestamp || frames) return extractYouTubeFramesContent(url, timestamp, frames, signal);

	let metadata: any | null = null;
	try { metadata = await getYouTubeMetadata(url, signal); } catch {}
	if (metadata) {
		const transcript = await fetchTranscriptFromMetadata(metadata, signal).catch(() => null);
		const title = metadata.title || "YouTube video";
		let content = `URL: ${url}\n`;
		content += `Title: ${title}\n`;
		if (metadata.uploader || metadata.channel) content += `Channel: ${metadata.uploader || metadata.channel}\n`;
		if (metadata.duration) content += `Duration: ${formatSeconds(metadata.duration)}\n`;
		if (prompt) content += `User prompt: ${prompt}\n`;
		if (metadata.description) content += `\n## Description\n\n${String(metadata.description).slice(0, 8_000)}\n`;
		if (transcript?.transcript) {
			content += `\n## Transcript${transcript.language ? ` (${transcript.language}${transcript.automatic ? ", auto" : ""})` : ""}\n\n${transcript.transcript}`;
		} else {
			content += "\nNo transcript/captions were available via yt-dlp.\n";
		}
		return makeTextResult("youtube", title, content, { url, videoId: metadata.id, duration: metadata.duration, hasTranscript: !!transcript?.transcript });
	}

	// Fallback: ask OpenAI web search to find public summaries/transcripts for the video.
	const fallbackQuery = prompt
		? `${prompt} YouTube video ${url}`
		: `summary transcript key points YouTube video ${url}`;
	const search = await searchWithOpenAI(fallbackQuery, { numResults: 5, signal }, ctx);
	const content = `${formatSearchResult(fallbackQuery, search)}\n\nNote: yt-dlp was unavailable or could not read metadata/transcripts, so this is a web-search-based fallback rather than direct video understanding.`;
	return makeTextResult("youtube", "YouTube web-search fallback", content, { url, fallback: "openai-web-search", provider: search.provider, model: search.model });
}

async function fetchOne(rawUrl: string, params: { prompt?: string; timestamp?: string; frames?: number; forceClone?: boolean }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ContentItemResult> {
	const trimmed = rawUrl.trim();
	if (!trimmed) throw new Error("Empty URL");
	const yt = isYouTubeUrl(trimmed);
	if (yt.isYouTube) return extractYouTubeContent(trimmed, params.prompt, params.timestamp, params.frames, signal, ctx);
	const github = parseGitHubUrl(trimmed);
	if (github) return extractGitHubContent(github, signal);
	return fetchHttpContent(trimmed, signal);
}

function normalizeUrlList(params: { url?: unknown; urls?: unknown }): string[] {
	const values = Array.isArray(params.urls) ? params.urls : (params.url !== undefined ? [params.url] : []);
	return values.filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using OpenAI Responses web_search. Reuses Pi OpenAI Codex subscription auth when available, or OPENAI_API_KEY. Output is truncated to 2000 lines/50KB when necessary.",
		promptSnippet: "Search current web information with OpenAI/Codex web_search and cite sources.",
		promptGuidelines: [
			"Use web_search for current information, external facts, releases, documentation, news, or anything not knowable from the local workspace.",
			"For broad research, call web_search with queries containing 2-4 varied search strings instead of one vague query.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. Prefer queries for multi-angle research." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries to run sequentially." })),
			numResults: Type.Optional(Type.Number({ description: "Approximate sources per query (default 5, max 20)." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Prefer recent results." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with '-' to exclude, e.g. ['docs.python.org', '-w3schools.com']." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const queries = Array.isArray(params.queries) ? params.queries : (params.query ? [params.query] : []);
			const queryList = queries.map(q => typeof q === "string" ? q.trim() : "").filter(Boolean);
			if (queryList.length === 0) throw new Error("No query provided. Use query or queries.");
			const outputs: string[] = [];
			const details: any[] = [];
			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];
				onUpdate?.({ content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: ${query}` }], details: { currentQuery: query, progress: i / queryList.length } });
				try {
					const response = await searchWithOpenAI(query, {
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						signal,
					}, ctx);
					outputs.push(formatSearchResult(query, response));
					details.push({ query, ...response });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					outputs.push(`## Search: ${query}\n\nError: ${message}`);
					details.push({ query, error: message });
				}
			}
			const combined = outputs.join("\n\n---\n\n");
			const result = await makeTextResult("web-search", "Web search results", combined, { queries: queryList });
			return { content: [{ type: "text", text: result.text }], details: { ...result.details, results: details } };
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL content as text/markdown. GitHub repository URLs are cloned locally and return a path. YouTube URLs use yt-dlp transcripts when available, OpenAI web-search fallback otherwise, and can extract frames with yt-dlp+ffmpeg. HTTP redirects are revalidated for SSRF protection. Output is truncated to 2000 lines/50KB; full text is saved to a temp file when truncated.",
		promptSnippet: "Fetch specific URLs, clone GitHub repos locally, or inspect YouTube transcripts/frames.",
		promptGuidelines: [
			"Use fetch_content when the user provides a URL or when web_search returns a source URL that needs detailed inspection.",
			"For GitHub URLs, fetch_content clones the repository and returns a local path; then use read or bash to inspect files in that clone.",
			"For YouTube URLs, fetch_content can return transcripts via yt-dlp and frame images when timestamp/frames are provided and ffmpeg is installed.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch." })),
			prompt: Type.Optional(Type.String({ description: "Question about a YouTube video; included with transcript/frame output." })),
			timestamp: Type.Optional(Type.String({ description: "For YouTube frame extraction: 'MM:SS', 'H:MM:SS', seconds, or range 'MM:SS-MM:SS'." })),
			frames: Type.Optional(Type.Number({ description: `Number of YouTube frames to extract (max ${MAX_FRAMES}). If timestamp is a range, defaults to 6.` })),
			forceClone: Type.Optional(Type.Boolean({ description: "Accepted for compatibility; GitHub repos are cloned by default." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const urls = normalizeUrlList(params);
			if (urls.length === 0) throw new Error("No URL provided. Use url or urls.");
			const texts: string[] = [];
			const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
			const details: TextResultDetails[] = [];
			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				onUpdate?.({ content: [{ type: "text", text: `Fetching ${i + 1}/${urls.length}: ${url}` }], details: { currentUrl: url, progress: i / urls.length } });
				try {
					const item = await fetchOne(url, params, signal, ctx);
					texts.push(item.text);
					details.push(item.details);
					if (item.images?.length) images.push(...item.images);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					texts.push(`# ${url}\n\nError: ${message}`);
					details.push({ type: "error", url, title: url, error: message });
				}
			}
			return {
				content: [
					{ type: "text", text: texts.join("\n\n---\n\n") },
					...images,
				],
				details: { count: urls.length, items: details, imageCount: images.length },
			};
		},
	});

	pi.registerCommand("web-access-status", {
		description: "Show web access provider/tool availability",
		handler: async (_args, ctx) => {
			const auth = await resolveOpenAIAuth(ctx);
			const lines = [
				`OpenAI/Codex search: ${auth ? `available (${auth.provider}/${auth.model})` : "unavailable"}`,
				`git: ${await commandExists(GIT) ? `available (${GIT})` : "missing"}`,
				`yt-dlp: ${await commandExists(YT_DLP) ? `available (${YT_DLP})` : "missing"}`,
				`ffmpeg: ${await commandExists(FFMPEG, ["-version"]) ? `available (${FFMPEG})` : "missing"}`,
				`Jina Reader fallback: ${ENABLE_JINA_READER ? "enabled" : "disabled"}`,
				`cache: ${CACHE_DIR}`,
			];
			ctx.ui.notify(lines.join("\n"), auth ? "info" : "warning");
		},
	});
}
