import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AIProvider } from '../types';

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

// Windows에서 claude.exe 절대 경로 자동 탐색
function resolveCliBin(cliBin: string): string {
	if (process.platform !== 'win32') return cliBin;
	// 이미 절대 경로면 그대로 사용
	if (cliBin !== 'claude' && cliBin.includes('\\')) return cliBin;
	// 알려진 설치 위치에서 최신 버전 탐색
	try {
		const base = path.join(
			process.env.LOCALAPPDATA ?? '',
			'Packages', 'Claude_pzs8sxrjxfjjc',
			'LocalCache', 'Roaming', 'Claude', 'claude-code'
		);
		if (!fs.existsSync(base)) return cliBin;
		const versions = fs.readdirSync(base)
			.filter(d => fs.statSync(path.join(base, d)).isDirectory())
			.sort()
			.reverse();
		for (const v of versions) {
			const exe = path.join(base, v, 'claude.exe');
			if (fs.existsSync(exe)) return exe;
		}
	// eslint-disable-next-line no-empty -- claude.exe path resolution failed; fall back to original bin
	} catch { }
	return cliBin;
}

// claude CLI를 비동기 subprocess로 호출하는 핵심 브릿지
// Anthropic Cloud API 직접 호출 금지 — 이 함수를 통해서만 LLM에 접근한다
export async function callClaude(prompt: string, cliBin = 'claude'): Promise<unknown> {
	const bin = resolveCliBin(cliBin);
	// .cmd 래퍼는 shell: true 필요, .exe 절대 경로는 직접 실행 (cmd.exe 8191자 한계 우회)
	const useShell = process.platform === 'win32' && !bin.toLowerCase().endsWith('.exe');
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, ['-p', prompt, '--output-format', 'json'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: useShell,
		});

		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

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

/**
 * Provider별 모델 라우팅
 * - claude-cli: 로컬 claude CLI (기본값)
 * - claude-api: Claude API (API 키 필요)
 * - gemini: Gemini API (API 키 필요)
 */
export async function callClaudeWithModel(
	prompt: string,
	cliBin: string = 'claude',
	model: ModelTier = 'standard',
	provider: AIProvider = 'claude-cli',
	claudeApiKey?: string,
	geminiApiKey?: string
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
	return new Promise((resolve, reject) => {
		const fullPrompt = `${systemPrompt}\n\n---\n\n${userContent}`;
		const proc = spawn(cliBin, ['-p', fullPrompt, '--output-format', 'json'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

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
