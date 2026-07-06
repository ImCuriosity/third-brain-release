import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "fs";

// Node.js built-in modules provided by Electron — replaces the builtin-modules package
const builtins = [
	'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
	'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https', 'module', 'net', 'os',
	'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
	'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url',
	'util', 'v8', 'vm', 'worker_threads', 'zlib',
];

const prod = process.argv[2] === "production";

// pdfjs worker(ES module)를 별도 번들링 후 Blob URL 문자열로 embed
const pdfjsWorkerPlugin = {
	name: "pdfjs-worker-inline",
	setup(build) {
		build.onResolve({ filter: /^pdfjs-worker-inline$/ }, () => ({
			path: "pdfjs-worker-inline",
			namespace: "pdfjs-worker-inline",
		}));
		build.onLoad({ namespace: "pdfjs-worker-inline", filter: /.*/ }, async () => {
			// worker를 IIFE로 번들링 (Web Worker classic format)
			const result = await esbuild.build({
				entryPoints: ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs"],
				bundle: true,
				format: "iife",
				write: false,
				minify: prod,
				target: "es2020",
			});
			const workerCode = result.outputFiles[0].text;
			// WorkerGlobalScope 환경에서 자동 초기화
			const fullCode =
				workerCode +
				"\n;if(typeof WorkerMessageHandler!=='undefined'){WorkerMessageHandler.setup(self,self);}";
			return {
				contents: `module.exports = ${JSON.stringify(fullCode)}`,
				loader: "js",
			};
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		// d3는 번들에 포함 (Obsidian이 제공하지 않음)
		// child_process 등 Node 빌트인은 builtins에 포함되어 Electron이 제공
		...builtins,
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	plugins: [pdfjsWorkerPlugin],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
