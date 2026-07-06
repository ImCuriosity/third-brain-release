import { requestUrl } from 'obsidian';
import type { ThirdBrainSettings } from '../types';
import { callClaudeWithModel } from './cli-bridge';

interface WhisperSegment { id: number; start: number; end: number; text: string; }
interface WhisperResponse { text: string; segments: WhisperSegment[]; language: string; }
interface SpeakerSegment { speaker: string; text: string; }
interface GPTSpeakerResult {
	speakers: string[];
	segments: Array<{ index: number; speaker: string; text: string }>;
}

export interface AudioTranscriptResult {
	title: string;
	transcript: string;
	language: string;
}

function buildWhisperBody(audioBuf: ArrayBuffer, filename: string): { body: ArrayBuffer; boundary: string } {
	const boundary = `ThirdBrainBoundary${Date.now()}`;
	const enc = new TextEncoder();

	const preamble = enc.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
		`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n` +
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
	);
	const suffix = enc.encode(`\r\n--${boundary}--\r\n`);

	const audioArr = new Uint8Array(audioBuf);
	const body = new Uint8Array(preamble.length + audioArr.length + suffix.length);
	body.set(preamble, 0);
	body.set(audioArr, preamble.length);
	body.set(suffix, preamble.length + audioArr.length);

	return { body: body.buffer, boundary };
}

async function whisperTranscribe(audioBuf: ArrayBuffer, filename: string, apiKey: string): Promise<WhisperResponse> {
	const { body, boundary } = buildWhisperBody(audioBuf, filename);

	const response = await requestUrl({
		url: 'https://api.openai.com/v1/audio/transcriptions',
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${apiKey.trim()}`,
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
		},
		body,
		throw: false,
	});

	if (response.status === 401) throw new Error('OpenAI API 키 인증 실패 (401)');
	if (response.status === 429) throw new Error('요청 한도 초과 (429) — 잠시 후 다시 시도하세요');
	if (response.status >= 400) {
		const err = response.json as { error?: { message?: string } };
		throw new Error(`Whisper API 오류: ${err?.error?.message ?? `HTTP ${response.status}`}`);
	}

	return response.json as WhisperResponse;
}

async function identifySpeakers(segments: WhisperSegment[], settings: ThirdBrainSettings): Promise<SpeakerSegment[]> {
	const ko = (settings.lang ?? 'ko') === 'ko';
	const segText = segments.map((s, i) => `[${i}] ${s.text.trim()}`).join('\n');

	const prompt = ko
		? `다음은 음성 전사록 세그먼트입니다. 말투, 어휘 선택, 문장 구조, 자주 쓰는 표현 등을 분석해 화자를 구분하세요.

세그먼트:
${segText}

각 세그먼트에 화자를 배정하세요. 화자 이름은 "화자 A", "화자 B" 형식으로, 구분이 어려우면 최선을 다해 추측하세요.
반드시 아래 JSON만 반환:
{"speakers":["화자 A","화자 B"],"segments":[{"index":0,"speaker":"화자 A","text":"텍스트"},...]}`
		: `Below are voice transcript segments. Analyze speaking style, vocabulary, and sentence structure to identify speakers.

Segments:
${segText}

Assign each segment to a speaker ("Speaker A", "Speaker B" format). Make your best guess when uncertain.
Return only this JSON:
{"speakers":["Speaker A","Speaker B"],"segments":[{"index":0,"speaker":"Speaker A","text":"text"},...]}`;

	try {
		const raw = await callClaudeWithModel(
			prompt, 'claude', 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey
		);
		const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as GPTSpeakerResult;
		return parsed.segments.map(s => ({ speaker: s.speaker, text: s.text }));
	} catch {
		return segments.map(s => ({ speaker: ko ? '화자' : 'Speaker', text: s.text.trim() }));
	}
}

async function inferTitle(transcript: string, settings: ThirdBrainSettings): Promise<string> {
	const ko = (settings.lang ?? 'ko') === 'ko';
	const excerpt = transcript.slice(0, 1500);

	const prompt = ko
		? `다음 전사록을 보고 짧은 제목을 만들어주세요. 한국어 20자 이내, 파일명에 쓸 수 있게 특수문자 없이 반환하세요.
전사록 일부:\n${excerpt}\n반드시 아래 JSON만 반환: {"title":"제목"}`
		: `Create a short title for this transcript. Under 25 characters, English, no special characters, filename-safe.
Excerpt:\n${excerpt}\nReturn only this JSON: {"title":"title"}`;

	try {
		const raw = await callClaudeWithModel(
			prompt, 'claude', 'standard',
			settings.aiProvider, settings.claudeApiKey, settings.geminiApiKey, settings.openaiApiKey
		);
		const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { title?: string };
		return (parsed.title ?? '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || (ko ? '전사록' : 'transcript');
	} catch {
		return ko ? '전사록' : 'transcript';
	}
}

export async function transcribeAudioFile(
	audioBuf: ArrayBuffer,
	filename: string,
	settings: ThirdBrainSettings,
	onProgress: (step: 'whisper' | 'speakers' | 'title') => void
): Promise<AudioTranscriptResult> {
	const apiKey = settings.openaiApiKey ?? '';

	onProgress('whisper');
	const whisperResult = await whisperTranscribe(audioBuf, filename, apiKey);

	onProgress('speakers');
	const speakerSegments = await identifySpeakers(whisperResult.segments, settings);

	// Merge consecutive same-speaker lines
	const lines: string[] = [];
	let prevSpeaker = '';
	for (const seg of speakerSegments) {
		const text = seg.text.trim();
		if (!text) continue;
		if (seg.speaker !== prevSpeaker) {
			if (lines.length > 0) lines.push('');
			lines.push(`[${seg.speaker}]`);
			prevSpeaker = seg.speaker;
		}
		lines.push(text);
	}
	const transcript = lines.join('\n');

	onProgress('title');
	const title = await inferTitle(transcript, settings);

	return { title, transcript, language: whisperResult.language };
}
