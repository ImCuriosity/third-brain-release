import { Platform } from 'obsidian';
import type { AIProvider } from '../types';

// ── Electron compat: local structural types — no @types/node needed ──────────
// Using window.require (Electron CommonJS) with inline structural types avoids
// @typescript-eslint/no-unsafe-* warnings in environments without @types/node.

// process 전역을 구조적 타입으로 캐스팅 — @types/node 없는 환경에서 no-unsafe-member-access 방지
const _proc = (window as Window & { process?: { platform: string; env: Record<string, string | undefined> } }).process
    ?? { platform: 'unknown', env: {} };

type LocalRequire = (module: string) => unknown;

interface LocalFS {
    existsSync(path: string): boolean;
    readdirSync(path: string): string[];
    statSync(path: string): { isDirectory(): boolean };
}
interface LocalPath {
    join(...paths: string[]): string;
}
interface LocalCP {
    execSync(command: string, options?: { timeout?: number }): { toString(): string };
}
// Buffer extends Uint8Array (ES2020 lib) with UTF-8 toString — no @types/node needed
interface NodeBuffer extends Uint8Array {
    toString(encoding?: string): string;
}
interface LocalReadable {
    on(event: 'data', listener: (chunk: NodeBuffer) => void): void;
}
interface LocalWritable {
    write(data: string): void;
    end(): void;
}
interface LocalChildProcess {
    stdout: LocalReadable | null;
    stderr: LocalReadable | null;
    stdin: LocalWritable | null;
    on(event: 'close', listener: (code: number | null) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
}
type LocalSpawnFn = (
    command: string,
    args: string[],
    options: { stdio: Array<'pipe' | 'ignore'>; shell?: boolean }
) => LocalChildProcess;

function getReq(): LocalRequire | undefined {
    return (window as Window & { require?: LocalRequire }).require;
}

// Obsidian requestUrl (v0 호환 방식)
type RequestUrlFn = (options: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}) => Promise<{ status: number; json: unknown }>;

interface AnthropicApiResponse {
	error?: { message?: string };
	content?: Array<{ type: string; text?: string }>;
}
interface GeminiApiResponse {
	error?: { message?: string };
	candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

let _requestUrl: RequestUrlFn | null = null;

export function setRequestUrl(fn: RequestUrlFn) {
	_requestUrl = fn;
}

// ── 세션 사용량 누적 ──────────────────────────────────────
interface SessionStats {
	callCount: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}
const _session: SessionStats = { callCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function getSessionStats(): Readonly<SessionStats> { return { ..._session }; }
export function resetSessionStats(): void {
	_session.callCount = 0; _session.inputTokens = 0; _session.outputTokens = 0; _session.costUsd = 0;
}

// ── envelope 파싱 + 통계 수집 ──────────────────────────────
function parseEnvelope(stdout: string): unknown {
	const text = stdout.trim();
	try {
		const outer = JSON.parse(text) as Record<string, unknown>;
		if (outer && typeof outer === 'object' && 'result' in outer) {
			// 사용량 누적
			_session.callCount++;
			const u = outer['usage'] as Record<string, number> | undefined;
			if (u) {
				_session.inputTokens  += u['input_tokens']  ?? 0;
				_session.outputTokens += u['output_tokens'] ?? 0;
			}
			const cost = outer['cost_usd'];
			if (typeof cost === 'number') _session.costUsd += cost;

			const inner = outer['result'];
			if (typeof inner === 'string') {
				try { return JSON.parse(inner); } catch { return inner; }
			}
			return inner;
		}
		return outer;
	} catch {
		return text;
	}
}

// 세션 내 경로 캐시 — 반복 탐색 방지
let _resolvedBin: string | null = null;

// Windows: where.exe PATH 탐색 → AppData 탐색 → 원래 bin 폴백
function resolveCliBin(cliBin: string): string {
	if (_proc.platform !== 'win32') return cliBin;
	if (cliBin !== 'claude' && cliBin.includes('\\')) return cliBin;

	// 캐시 히트
	if (_resolvedBin !== null) return _resolvedBin;

	try {
		const req = getReq();
		if (!req) { _resolvedBin = cliBin; return cliBin; }

		const fs   = req('fs')   as LocalFS;
		const path = req('path') as LocalPath;
		const cp   = req('child_process') as LocalCP;

		// 1차: where.exe로 PATH 탐색 (npm global 설치 등)
		try {
			const found = cp.execSync('where.exe claude 2>NUL', { timeout: 2000 })
				.toString().trim().split(/\r?\n/)[0]?.trim();
			if (found && fs.existsSync(found)) {
				_resolvedBin = found;
				return found;
			}
		// eslint-disable-next-line no-empty -- where.exe 실패 시 AppData 탐색으로 폴백
		} catch { }

		// 2차: AppData Store 설치 경로 탐색
		const base = path.join(
			_proc.env['LOCALAPPDATA'] ?? '',
			'Packages', 'Claude_pzs8sxrjxfjjc',
			'LocalCache', 'Roaming', 'Claude', 'claude-code'
		);
		if (fs.existsSync(base)) {
			const versions = fs.readdirSync(base)
				.filter(d => fs.statSync(path.join(base, d)).isDirectory())
				.sort().reverse();
			for (const v of versions) {
				const exe = path.join(base, v, 'claude.exe');
				if (fs.existsSync(exe)) {
					_resolvedBin = exe;
					return exe;
				}
			}
		}
	// eslint-disable-next-line no-empty -- 탐색 전체 실패 시 원래 bin으로 폴백
	} catch { }

	_resolvedBin = cliBin;
	return cliBin;
}

// claude CLI를 비동기 subprocess로 호출하는 핵심 브릿지
// Anthropic Cloud API 직접 호출 금지 — 이 함수를 통해서만 LLM에 접근한다
export async function callClaude(prompt: string, cliBin = 'claude'): Promise<unknown> {
	if (Platform.isMobile) throw new Error('Claude CLI는 모바일에서 지원되지 않습니다. 설정에서 API 기반 제공자를 선택하세요.');
	const bin = resolveCliBin(cliBin);
	// .exe 절대 경로는 직접 실행 (cmd.exe 8191자 한계 없음), 아니면 shell:true
	const useShell = _proc.platform === 'win32' && !bin.toLowerCase().endsWith('.exe');

	const req = getReq();
	if (!req) return Promise.reject(new Error('Electron window.require not available'));
	const { spawn } = req('child_process') as { spawn: LocalSpawnFn };

	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';

		let proc: LocalChildProcess;

		if (useShell) {
			// shell:true + 긴 프롬프트 → stdin 파이프로 cmd.exe 8191자 한계 우회
			proc = spawn(bin, ['--output-format', 'json'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: true,
			});
			proc.stdin?.write(prompt);
			proc.stdin?.end();
		} else {
			proc = spawn(bin, ['-p', prompt, '--output-format', 'json'], {
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
			});
		}

		proc.stdout?.on('data', (chunk: NodeBuffer) => { stdout += chunk.toString(); });
		proc.stderr?.on('data', (chunk: NodeBuffer) => { stderr += chunk.toString(); });

		proc.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`claude CLI 오류 (code ${code}): ${stderr.trim() || '(stderr 없음)'}\n실행: ${bin}`));
				return;
			}
			resolve(parseEnvelope(stdout));
		});

		proc.on('error', (err) => {
			reject(new Error(`claude CLI 실행 실패: ${err.message}\n경로: ${bin}\n설정에서 'claude CLI 경로'를 절대 경로로 지정해보세요.`));
		});
	});
}

// ── 모델 라우팅 (효율성 최적화) ────────────────────────────

export type ModelTier = 'fast' | 'standard';

const CLAUDE_API_MODEL_MAP: Record<ModelTier, string> = {
	fast:     'claude-haiku-4-5-20251001',      // Claude Haiku 4.5
	standard: 'claude-sonnet-4-6',              // Claude Sonnet 4.6
};

const GEMINI_MODEL_MAP: Record<ModelTier, string> = {
	fast:     'gemini-3.5-flash',               // Gemini 3.5 Flash (최신 안정)
	standard: 'gemini-2.5-pro',                 // Gemini 2.5 Pro (가장 강력)
};

const OPENAI_MODEL_MAP: Record<ModelTier, string> = {
	fast:     'gpt-4o-mini',                    // GPT-4o Mini (저렴·빠름)
	standard: 'gpt-4o',                         // GPT-4o (플래그십)
};

// ── Claude API 호출 (v0 호환: Obsidian requestUrl 사용) ──────

async function callClaudeAPI(
	prompt: string,
	apiKey: string,
	model: ModelTier = 'standard'
): Promise<unknown> {
	try {
		// API 키 검증
		if (!apiKey || apiKey.trim().length === 0) {
			throw new Error('Claude API 키가 비어있습니다');
		}
		if (!apiKey.startsWith('sk-ant-')) {
			throw new Error('Claude API 키 형식이 올바르지 않습니다 (sk-ant-로 시작해야 합니다)');
		}

		// requestUrl 사용 가능 여부 확인
		if (!_requestUrl) {
			throw new Error('Obsidian requestUrl이 초기화되지 않았습니다. Claude CLI를 사용해주세요.');
		}


		const response = await _requestUrl({
			url: 'https://api.anthropic.com/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey.trim(),
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			body: JSON.stringify({
				model: CLAUDE_API_MODEL_MAP[model],
				max_tokens: 4096,
				messages: [
					{ role: 'user', content: prompt }
				],
			}),
			throw: false,
		});

		// HTTP 상태 코드 확인
		if (response.status === 401) {
			throw new Error('API 키 인증 실패 (HTTP 401) - API 키를 확인하세요');
		}
		if (response.status === 429) {
			throw new Error('요청 한도 초과 (HTTP 429) - 잠시 후 다시 시도하세요');
		}
		if (response.status >= 400) {
			const errData = response.json as AnthropicApiResponse;
			const errorMsg = errData?.error?.message ?? `HTTP ${response.status}`;
			throw new Error(`Anthropic API 오류: ${errorMsg}`);
		}

		// 응답 파싱
		const data = response.json as AnthropicApiResponse;
		const content = data?.content?.[0];

		if (content?.type === 'text') {
			try {
				return JSON.parse(content.text ?? '');
			} catch {
				return content.text;
			}
		}

		return content ?? data;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Claude API 호출 실패: ${msg}`);
	}
}

// ── Gemini API 호출 (v0 호환: Obsidian requestUrl 사용) ──────

async function callGeminiAPI(
	prompt: string,
	apiKey: string,
	model: ModelTier = 'standard'
): Promise<unknown> {
	try {
		// API 키 검증
		if (!apiKey || apiKey.trim().length === 0) {
			throw new Error('Gemini API 키가 비어있습니다');
		}

		// requestUrl 사용 가능 여부 확인
		if (!_requestUrl) {
			throw new Error('Obsidian requestUrl이 초기화되지 않았습니다. Claude CLI를 사용해주세요.');
		}


		const response = await _requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_MAP[model]}:generateContent?key=${apiKey.trim()}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{ text: prompt }
						],
					}
				],
			}),
			throw: false,
		});

		// HTTP 상태 코드 확인
		if (response.status === 401) {
			throw new Error('API 키 인증 실패 (HTTP 401) - API 키를 확인하세요');
		}
		if (response.status === 429) {
			throw new Error('요청 한도 초과 (HTTP 429) - 잠시 후 다시 시도하세요');
		}
		if (response.status >= 400) {
			const errData = response.json as GeminiApiResponse;
			const errorMsg = errData?.error?.message ?? `HTTP ${response.status}`;
			throw new Error(`Gemini API 오류: ${errorMsg}`);
		}

		// 응답 파싱
		const data = response.json as GeminiApiResponse;
		const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

		if (text) {
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		}

		return data;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Gemini API 호출 실패: ${msg}`);
	}
}

// ── OpenAI API 호출 (Obsidian requestUrl 사용) ───────────────

interface OpenAIApiResponse {
	choices?: Array<{ message?: { content?: string } }>;
	error?: { message?: string };
}

async function callOpenAIAPI(
	prompt: string,
	apiKey: string,
	model: ModelTier = 'standard',
	jsonMode = true
): Promise<unknown> {
	try {
		if (!apiKey || apiKey.trim().length === 0) {
			throw new Error('OpenAI API 키가 비어있습니다');
		}
		if (!apiKey.startsWith('sk-')) {
			throw new Error('OpenAI API 키 형식이 올바르지 않습니다 (sk-로 시작해야 합니다)');
		}
		if (!_requestUrl) {
			throw new Error('Obsidian requestUrl이 초기화되지 않았습니다.');
		}

		const response = await _requestUrl({
			url: 'https://api.openai.com/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey.trim()}`,
			},
			body: JSON.stringify({
				model: OPENAI_MODEL_MAP[model],
				max_tokens: 4096,
				...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
				messages: [{ role: 'user', content: prompt }],
			}),
			throw: false,
		});

		if (response.status === 401) throw new Error('API 키 인증 실패 (HTTP 401) - API 키를 확인하세요');
		if (response.status === 429) throw new Error('요청 한도 초과 (HTTP 429) - 잠시 후 다시 시도하세요');
		if (response.status >= 400) {
			const errData = response.json as OpenAIApiResponse;
			throw new Error(`OpenAI API 오류: ${errData?.error?.message ?? `HTTP ${response.status}`}`);
		}

		const data = response.json as OpenAIApiResponse;
		const text = data?.choices?.[0]?.message?.content;
		if (text) {
			try { return JSON.parse(text); } catch { return text; }
		}
		return data;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`OpenAI API 호출 실패: ${msg}`);
	}
}

/**
 * Provider별 모델 라우팅
 * - claude-cli: 로컬 claude CLI (기본값)
 * - claude-api: Claude API (API 키 필요)
 * - gemini: Gemini API (API 키 필요)
 * - openai: OpenAI GPT API (API 키 필요)
 */
export async function callClaudeWithModel(
	prompt: string,
	cliBin: string = 'claude',
	model: ModelTier = 'standard',
	provider: AIProvider = 'claude-cli',
	claudeApiKey?: string,
	geminiApiKey?: string,
	openaiApiKey?: string,
	jsonMode = true
): Promise<unknown> {

	switch (provider) {
		case 'claude-cli':
			return callClaude(prompt, cliBin);

		case 'claude-api':
			if (!claudeApiKey) throw new Error('Claude API 키가 설정되지 않았습니다');
			return callClaudeAPI(prompt, claudeApiKey, model);

		case 'gemini':
			if (!geminiApiKey) throw new Error('Gemini API 키가 설정되지 않았습니다');
			return callGeminiAPI(prompt, geminiApiKey, model);

		case 'openai':
			if (!openaiApiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
			return callOpenAIAPI(prompt, openaiApiKey, model, jsonMode);

		default:
			throw new Error(`지원하지 않는 AI 제공자: ${provider as string}`);
	}
}

// 대용량 텍스트 인제스트용 — stdin 파이프 방식
export async function callClaudeWithStdin(
	systemPrompt: string,
	userContent: string,
	cliBin = 'claude'
): Promise<unknown> {
	if (Platform.isMobile) throw new Error('Claude CLI는 모바일에서 지원되지 않습니다. 설정에서 API 기반 제공자를 선택하세요.');
	const bin = resolveCliBin(cliBin);
	const useShell = _proc.platform === 'win32' && !bin.toLowerCase().endsWith('.exe');

	const req = getReq();
	if (!req) return Promise.reject(new Error('Electron window.require not available'));
	const { spawn } = req('child_process') as { spawn: LocalSpawnFn };

	return new Promise((resolve, reject) => {
		const fullPrompt = `${systemPrompt}\n\n---\n\n${userContent}`;
		let stdout = '';
		let stderr = '';
		let proc: LocalChildProcess;

		if (useShell) {
			// shell:true → stdin 파이프로 cmd.exe 8191자 한계 우회
			proc = spawn(bin, ['--output-format', 'json'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: true,
			});
			proc.stdin?.write(fullPrompt);
			proc.stdin?.end();
		} else {
			proc = spawn(bin, ['-p', fullPrompt, '--output-format', 'json'], {
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
			});
		}

		proc.stdout?.on('data', (chunk: NodeBuffer) => { stdout += chunk.toString(); });
		proc.stderr?.on('data', (chunk: NodeBuffer) => { stderr += chunk.toString(); });

		proc.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`claude CLI 오류 (code ${code}): ${stderr.trim()}`));
				return;
			}
			resolve(parseEnvelope(stdout));
		});

		proc.on('error', (err) => {
			reject(new Error(`claude CLI 실행 실패: ${err.message}`));
		});
	});
}
