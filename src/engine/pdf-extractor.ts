import * as pdfjsLib from 'pdfjs-dist';

// Worker 코드가 빌드 시점에 IIFE 문자열로 embed됨 (esbuild pdfjs-worker-inline 플러그인)
 
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfjs-worker-inline is a virtual esbuild module that embeds the worker as a string
const workerScript = require('pdfjs-worker-inline') as string;

let workerUrl: string | null = null;

function ensureWorker() {
	if (workerUrl) return;
	const blob = new Blob([workerScript], { type: 'application/javascript' });
	workerUrl = URL.createObjectURL(blob);
	pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
	ensureWorker();

	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(buffer),
		verbosity: 0, // VerbosityLevel.ERRORS — suppress info/warning logs
	});
	const pdf = await loadingTask.promise;

	const pages: string[] = [];
	for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
		const page = await pdf.getPage(pageNum);
		const content = await page.getTextContent();
		const text = content.items
			.map((item) => ('str' in item ? item.str : ''))
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) pages.push(text);
	}

	return pages.join('\n\n');
}
