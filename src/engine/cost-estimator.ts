// ── AI 비용/토큰/시간 사전 추정 ───────────────────────────────
// 사용자가 토큰을 소비하기 전에 "이 작업은 약 얼마의 토큰·비용·시간이 든다"를 알려주기 위한 순수 추정 로직.
// 정확한 값이 아니라 근사치(약)다 — 실제 사용량은 호출 후 getSessionStats()로 누적된다.

import type { AIProvider } from '../types';
import type { ModelTier } from './cli-bridge';

// 사용자가 누르는 AI 작업 단위
export type AIOperationKind =
	| 'pipeline'        // 생성 (명제·엣지·액션·문제·크로스연결 다중 패스)
	| 'analysis'        // 폴더 분석 (다이제스트)
	| 'bridge'          // 연결 (폴더 간 크로스 커넥션)
	| 'graph-analysis'  // 그래프 분석 (전 노드 요약)
	| 'orphan-lint'     // 고립 노드 린팅 (고립당 1회)
	| 'transcript'      // 전사본 분석
	| 'audio'           // 음성 전사
	| 'workbench';      // 작업대 채팅 (폴더 그라운딩 Q&A — 세션 첫 질문에만 게이트)

// 1M 토큰당 USD (입력/출력) — 근사 공개 가격 기준. provider별 tier 매핑.
const PRICING: Record<AIProvider, Record<ModelTier, { in: number; out: number }>> = {
	'claude-cli': { fast: { in: 1.0, out: 5.0 }, standard: { in: 3.0, out: 15.0 } },
	'claude-api': { fast: { in: 1.0, out: 5.0 }, standard: { in: 3.0, out: 15.0 } },
	'gemini':     { fast: { in: 0.30, out: 2.50 }, standard: { in: 1.25, out: 10.0 } },
	'openai':     { fast: { in: 0.15, out: 0.60 }, standard: { in: 2.50, out: 10.0 } },
};

// tier별 유효 출력 처리량(토큰/초) — 지연 포함 벽시계 기준 근사
const THROUGHPUT: Record<ModelTier, number> = { fast: 55, standard: 30 };

// 호출당 고정 지연(초) — CLI는 subprocess 스폰 비용으로 더 큼
function perCallLatency(provider: AIProvider): number {
	return provider === 'claude-cli' ? 3.0 : 1.5;
}

// 한글 혼합 텍스트 기준 문자→토큰 환산 (약간 보수적으로 잡아 과소추정 방지)
const CHARS_PER_TOKEN = 2.0;
// 호출당 시스템 프롬프트 오버헤드 토큰(근사)
const SYSTEM_OVERHEAD_TOKENS = 700;

interface OperationProfile {
	passMultiplier: number;   // 입력이 몇 번 재처리되는가 (다중 패스)
	outputRatio: number;      // 출력 토큰 ≈ 기본 입력 토큰 × 비율
	charsPerCall: number;     // units 미지정 시 호출 수 추정용 (문자/호출)
}

const PROFILES: Record<AIOperationKind, OperationProfile> = {
	'pipeline':       { passMultiplier: 3.5, outputRatio: 0.50, charsPerCall: 800 },
	'analysis':       { passMultiplier: 1.2, outputRatio: 0.40, charsPerCall: 6000 },
	'bridge':         { passMultiplier: 1.3, outputRatio: 0.30, charsPerCall: 4000 },
	'graph-analysis': { passMultiplier: 1.2, outputRatio: 0.40, charsPerCall: 6000 },
	'orphan-lint':    { passMultiplier: 1.5, outputRatio: 0.20, charsPerCall: 2000 },
	'transcript':     { passMultiplier: 1.1, outputRatio: 0.50, charsPerCall: 8000 },
	'audio':          { passMultiplier: 1.0, outputRatio: 0.30, charsPerCall: 100000 },
	'workbench':      { passMultiplier: 1.0, outputRatio: 0.25, charsPerCall: 30000 },
};

export interface AIOperationRequest {
	operation: AIOperationKind;
	charCount: number;       // 주 입력 텍스트 길이
	units?: number;          // 작업별 실제 호출 단위 수 (청크·고립 수·노드쌍 등) — 알면 정확도↑
	tier: ModelTier;
	provider: AIProvider;
}

export interface AICostEstimate {
	operation: AIOperationKind;
	provider: AIProvider;
	tier: ModelTier;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	seconds: number;
	isSubscription: boolean;  // claude-cli → 직접 과금이 아니라 구독 사용량
}

export function estimateAIOperation(req: AIOperationRequest): AICostEstimate {
	const profile = PROFILES[req.operation];
	const price = PRICING[req.provider][req.tier];

	const baseInputTokens = Math.ceil(Math.max(0, req.charCount) / CHARS_PER_TOKEN);
	const calls = Math.max(1, req.units ?? Math.ceil(req.charCount / profile.charsPerCall));

	const inputTokens = Math.round(baseInputTokens * profile.passMultiplier + SYSTEM_OVERHEAD_TOKENS * calls);
	const outputTokens = Math.round(baseInputTokens * profile.outputRatio);
	const totalTokens = inputTokens + outputTokens;

	const costUsd = (inputTokens / 1_000_000) * price.in + (outputTokens / 1_000_000) * price.out;
	const seconds = calls * perCallLatency(req.provider) + outputTokens / THROUGHPUT[req.tier];

	return {
		operation: req.operation,
		provider: req.provider,
		tier: req.tier,
		calls,
		inputTokens,
		outputTokens,
		totalTokens,
		costUsd,
		seconds: Math.round(seconds),
		isSubscription: req.provider === 'claude-cli',
	};
}

// ── 표시용 포매터 ───────────────────────────────────────────

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
	return `${n}`;
}

export function formatCostUsd(usd: number): string {
	if (usd < 0.01) return '<$0.01';
	if (usd < 1) return `$${usd.toFixed(2)}`;
	return `$${usd.toFixed(2)}`;
}

export function formatDuration(sec: number, ko: boolean): string {
	if (sec < 60) return ko ? `약 ${sec}초` : `~${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (ko) return s > 0 ? `약 ${m}분 ${s}초` : `약 ${m}분`;
	return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

export function modelLabel(provider: AIProvider, tier: ModelTier): string {
	const map: Record<AIProvider, Record<ModelTier, string>> = {
		'claude-cli': { fast: 'Claude CLI · Haiku 4.5', standard: 'Claude CLI · Sonnet 4.6' },
		'claude-api': { fast: 'Claude Haiku 4.5', standard: 'Claude Sonnet 4.6' },
		'gemini':     { fast: 'Gemini 3.5 Flash', standard: 'Gemini 2.5 Pro' },
		'openai':     { fast: 'GPT-4o mini', standard: 'GPT-4o' },
	};
	return map[provider][tier];
}
