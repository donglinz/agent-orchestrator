/// <reference path="../../src/renderer/global.d.ts" />
// Browser-only workload fixture: real AO rendering, deterministic synthetic data.
// This entry is never imported by the application or included in its build.
import { Profiler, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
	QueryClient,
	QueryClientProvider,
	QueryObserver,
} from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { appI18n } from "../../src/renderer/i18n";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { AssistantMessage } from "../../src/renderer/components/chat/ChatTimelineItems";
import { ChatWorkspace } from "../../src/renderer/components/chat/ChatWorkspace";
import { chatFixtureLongHistory } from "../../src/renderer/lib/chat-fixture";
import { highlight } from "../../src/renderer/lib/code-highlight";
import { createEventTransport } from "../../src/renderer/lib/event-transport";
import { useUiStore } from "../../src/renderer/stores/ui-store";
import { setApiBaseUrl } from "../../src/renderer/lib/api-client";
import type {
	ConversationItem,
	ConversationMessage,
	ConversationSnapshot,
	ConversationTurn,
} from "../../src/renderer/types/conversation";
import "../../src/renderer/styles.css";

const root = createRoot(document.getElementById("performance-root")!);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const wait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () =>
	new Promise<number>((resolve) => requestAnimationFrame(resolve));
function render(node: ReactNode) {
	flushSync(() =>
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={appI18n}>
					<TooltipProvider>{node}</TooltipProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
}
function assistant(text: string, streaming = true): ConversationMessage {
	return {
		kind: "message",
		id: "performance-message",
		sequence: 1,
		revision: 0,
		role: "assistant",
		origin: "provider",
		text,
		streaming,
		createdAt: "2026-09-05T00:00:00Z",
	};
}

/**
 * One turn that has been running for hours, with a long queued-message dock behind
 * it: the shape of an orchestrator that sat in a single poll loop while workers
 * reported in. Generated, with sizes taken from the incident (about 680 KB of
 * snapshot JSON, 28 queued report batches), because the shape matters, not the text.
 */
function hugeLiveTurnSnapshot(
	options: { items: number; queued: number; outputLines?: number; queuedReports?: number; liveStreaming?: boolean; tick?: number; liveReplyParagraphs?: number },
): ConversationSnapshot {
	const at = (second: number) =>
		new Date(Date.UTC(2026, 9, 14, 0, 0, 0) + second * 1000).toISOString();
	const turns: ConversationTurn[] = [
		{
			id: "turn-live",
			state: "running",
			requestedAt: at(0),
			startedAt: at(1),
		},
	];
	const items: ConversationItem[] = [];
	let sequence = 0;
	items.push({
		kind: "message",
		id: "huge-prompt",
		turnId: "turn-live",
		sequence: (sequence += 1),
		revision: 0,
		role: "user",
		origin: "human",
		text: "Run the submission loop and poll the workers until every kernel passes.",
		streaming: false,
		delivery: "accepted",
		createdAt: at(1),
	});
	for (let index = 0; index < options.items; index += 1) {
		const second = 2 + index * 7;
		const kind = index % 4;
		if (kind === 3) {
			items.push({
				kind: "message",
				id: `huge-reply-${index}`,
				turnId: "turn-live",
				sequence: (sequence += 1),
				revision: 2,
				role: "assistant",
				origin: "provider",
				text:
					`Poll ${index}: worker ao-${index % 9} reports the benchmark is still running; ` +
					"checking the board again.\n\n- kernel `gemm_fp8` pending\n- kernel `attn_decode` passing\n\n" +
					"```bash\nao session ls --project sol-execbench\n```",
				streaming: false,
				createdAt: at(second),
			});
		} else {
			items.push({
				kind: "activity",
				id: `huge-activity-${index}`,
				turnId: "turn-live",
				sequence: (sequence += 1),
				revision: 0,
				activityKind: "command",
				status: "completed",
				summary: "ao session ls --project sol-execbench",
				detail: {
					command: "ao session ls --project sol-execbench",
					output: Array.from(
						{ length: options.outputLines ?? 6 },
						(_, line) => `ao-${line % 9} working kernel ${index}-${line} 00:${line}0 status=running`,
					).join("\n"),
					exitCode: 0,
					durationMs: 120 + (index % 40),
				},
				createdAt: at(second),
			});
		}
	}
	// The live edge of the turn: a streaming reply that grows on every refresh.
	items.push({
		kind: "message",
		id: "huge-live-reply",
		turnId: "turn-live",
		sequence: (sequence += 1),
		revision: options.tick ?? 0,
		role: "assistant",
		origin: "provider",
		// Earlier paragraphs (and a code block) are finished prose; the last one grows.
		text:
			Array.from({ length: (options.liveReplyParagraphs ?? 1) - 1 }, (_, paragraph) =>
				paragraph % 4 === 3
					? "```bash\nao session ls --project sol-execbench\nao report --done\n```"
					: `Paragraph ${paragraph}: the worker reported **kernel ${paragraph}** passing and \`attn_decode\` still pending, so I am polling the board again ` +
						"before assigning the next batch of kernels to the idle workers. ".repeat(3),
			)
				.concat("Still polling. ".repeat(4 + (options.tick ?? 0)))
				.join("\n\n"),
		streaming: options.liveStreaming ?? true,
		createdAt: at(2 + options.items * 7),
	});
	for (let index = 0; index < options.queued; index += 1) {
		const turnId = `turn-queued-${index}`;
		turns.push({ id: turnId, state: "queued", requestedAt: at(100 + index) });
		items.push({
			kind: "message",
			id: `huge-queued-${index}`,
			turnId,
			sequence: (sequence += 1),
			revision: 0,
			role: "user",
			origin: "human",
			text:
				`<ao-worker-reports>\n${Array.from(
					{ length: options.queuedReports ?? 4 },
					(_, report) =>
						`[ao-${(index + report) % 9}] checkpoint: kernel batch ${index}.${report} finished, ` +
						"results attached, waiting on the next assignment. ".repeat(3),
				).join("\n")}\n</ao-worker-reports>`,
			streaming: false,
			delivery: "queued",
			createdAt: at(100 + index),
		});
	}
	return {
		conversationId: "conv-huge",
		sessionId: "ao-huge",
		harness: "codex",
		mode: "chat",
		controller: { state: "busy" },
		turns,
		items,
		latestSequence: sequence,
		oldestSequence: 1,
		// The daemon serves the newest 200 rows; the rest of a long turn is paged in.
		hasMoreBefore: true,
		settings: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
		capabilities: ["steer"],
	};
}

/** A refetch hands the renderer brand-new objects for every row, even unchanged ones. */
const refetched = (snapshot: ConversationSnapshot): ConversationSnapshot =>
	JSON.parse(JSON.stringify(snapshot));

const percentile = (values: number[], fraction: number) =>
	[...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;

export const performanceHarness = {
	async events() {
		const original = window.EventSource;
		const sources: BenchSource[] = [];
		class BenchSource {
			readyState = 1;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: ((event: Event) => void) | null = null;
			listeners = new Map<string, EventListener[]>();
			constructor(public url: string) {
				sources.push(this);
			}
			addEventListener(type: string, listener: EventListener) {
				this.listeners.set(type, [
					...(this.listeners.get(type) ?? []),
					listener,
				]);
			}
			close() {
				this.readyState = 2;
			}
			emit(data: string) {
				for (const listener of this.listeners.get("session_updated") ?? [])
					listener(new MessageEvent("session_updated", { data }));
			}
		}
		window.EventSource = BenchSource as unknown as typeof EventSource;
		setApiBaseUrl("http://127.0.0.1:8080");
		const queryClient = new QueryClient();
		const queryKey = ["conversation", "performance-session"];
		queryClient.setQueryData(queryKey, 0);
		const flushes: number[] = [];
		const completions: number[] = [];
		let started = performance.now();
		const observer = new QueryObserver(queryClient, {
			queryKey,
			staleTime: Infinity,
			queryFn: async () => {
				flushes.push(performance.now() - started);
				await wait(30);
				completions.push(performance.now() - started);
				return completions.length;
			},
		});
		const unsubscribe = observer.subscribe(() => {});
		const disconnect = createEventTransport(queryClient).connect();
		try {
			// The bridge delivers an initial daemon-status callback. Let its full
			// lifecycle refresh finish before measuring conversation-only traffic.
			await wait(500);
			flushes.length = 0;
			completions.length = 0;
			started = performance.now();
			const source = sources.find((entry) =>
				entry.url.includes("/api/v1/events"),
			)!;
			for (let index = 0; index < 20; index++) {
				source.emit(
					JSON.stringify({
						sessionId: "performance-session",
						payload: { conversationId: "performance-conversation" },
					}),
				);
				await wait(100);
			}
			const streamEndedMs = performance.now() - started;
			await wait(250);
			return {
				firstRefreshMs: flushes[0] ?? null,
				refreshCount: flushes.length,
				refreshesDuringStream: flushes.filter((time) => time < streamEndedMs)
					.length,
				streamEndedMs,
				flushes,
				completions,
			};
		} finally {
			disconnect();
			unsubscribe();
			queryClient.clear();
			window.EventSource = original;
		}
	},
	async streaming() {
		render(<AssistantMessage message={assistant("Start ")} />);
		await frame();
		await frame();
		const target = "Start " + "responsive output 👨‍👩‍👧‍👦 é ".repeat(30) + ".";
		const started = performance.now();
		render(<AssistantMessage message={assistant(target)} />);
		let frames = 0;
		while (
			document.querySelector(".chat-md")?.textContent !== target &&
			performance.now() - started < 15000
		) {
			await frame();
			frames++;
		}
		const visibleMs = performance.now() - started;
		const exact = document.querySelector(".chat-md")?.textContent === target;
		render(<AssistantMessage message={assistant(target, false)} showCopy />);
		await frame();
		return {
			receivedCharacters: target.length,
			visibleMs,
			frames,
			exact,
			completedCopyAvailable: Boolean(
				document.querySelector('[aria-label="Copy message as markdown"]'),
			),
		};
	},
	async highlighting() {
		// Load the existing grammar chunk first so this isolates large-block work,
		// not network/module fetch differences. The worker still starts lazily.
		await highlight("const warmup = 1", "typescript");
		const code = Array.from(
			{ length: 10000 },
			(_, index) => `const value${index}: string = "Unicode 👨‍👩‍👧‍👦 ${index}";`,
		).join("\n");
		const gaps: number[] = [];
		let previous = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			gaps.push(now - previous);
			previous = now;
		}, 4);
		await wait(30);
		const started = performance.now();
		const tree = await highlight(code, "typescript");
		const elapsedMs = performance.now() - started;
		await wait(30);
		clearInterval(timer);
		function flatten(node: {
			type: string;
			value?: string;
			children?: unknown[];
		}): string {
			return node.type === "text"
				? (node.value ?? "")
				: (node.children ?? [])
						.map((child) => flatten(child as typeof node))
						.join("");
		}
		return {
			codeCharacters: code.length,
			elapsedMs,
			maxEventLoopGapMs: Math.max(...gaps),
			samples: gaps,
			textPreserved: Boolean(tree) && flatten(tree!) === code,
		};
	},
	async history() {
		useUiStore.setState({
			inspectorSessions: { "ao-long": { isOpen: false, view: "summary" } },
		});
		render(
			<ChatWorkspace
				snapshot={chatFixtureLongHistory(250)}
				sessionTitle="AO responsiveness benchmark"
			/>,
		);
		await document.fonts.ready;
		await wait(500);
		const scroller = document.querySelector<HTMLElement>(
			'[role="log"][aria-label="Conversation"]',
		)!;
		if (!scroller) throw new Error("Conversation did not mount");
		scroller.scrollTop = 0;
		scroller.dispatchEvent(new Event("scroll"));
		await frame();
		await frame();
		const original = Element.prototype.getBoundingClientRect;
		let anchorReads = 0;
		Element.prototype.getBoundingClientRect = function () {
			if (this.hasAttribute("data-chat-scroll-anchor")) anchorReads++;
			return original.call(this);
		};
		const frameGaps: number[] = [];
		let last = await frame();
		try {
			for (let index = 0; index < 120; index++) {
				scroller.scrollTop =
					((scroller.scrollHeight - scroller.clientHeight) * index) / 119;
				scroller.dispatchEvent(new Event("scroll"));
				const now = await frame();
				frameGaps.push(now - last);
				last = now;
			}
		} finally {
			Element.prototype.getBoundingClientRect = original;
		}
		return {
			loadedTurns: 250,
			anchorReads,
			mountedTurns: scroller.querySelectorAll("[data-chat-scroll-anchor]")
				.length,
			maxFrameGapMs: Math.max(0, ...frameGaps),
			frameGaps,
		};
	},
	/**
	 * A huge live turn plus a long queued dock: how expensive is a snapshot refresh,
	 * a keystroke in the composer, and a scroll through the turn?
	 */
	async hugeTurn(
		options: { items?: number; queued?: number; outputLines?: number; queuedReports?: number; liveStreaming?: boolean; refreshes?: number; phases?: string[]; liveReplyParagraphs?: number } = {},
	) {
		// About 900 rows of live turn (a few pages of the 200-row history the daemon
		// serves, as after scrolling back) and ~600 KB of snapshot JSON.
		const items = options.items ?? 900;
		const queued = options.queued ?? 28;
		const outputLines = options.outputLines ?? 8;
		const queuedReports = options.queuedReports ?? 4;
		const refreshes = options.refreshes ?? 12;
		const liveStreaming = options.liveStreaming ?? true;
		const liveReplyParagraphs = options.liveReplyParagraphs ?? 1;
		const runs = (name: string) => !options.phases || options.phases.includes(name);
		useUiStore.setState({
			inspectorSessions: { "ao-huge": { isOpen: false, view: "summary" } },
		});
		const commits: { phase: string; actual: number; base: number }[] = [];
		let phase = "mount";
		const mount = (snapshot: ConversationSnapshot) =>
			render(
				<Profiler
					id="chat"
					onRender={(_id, _phase, actual, base) =>
						commits.push({ phase, actual, base })
					}
				>
					<ChatWorkspace
						snapshot={snapshot}
						sessionTitle="Huge live turn"
						// Fresh arrows on every render, as useConversationCommands hands them out.
						onSend={() => {}}
						onPromoteQueuedTurn={async () => {}}
						onEditQueuedTurn={async () => {}}
						onCancelQueuedTurn={async () => {}}
						onReorderQueuedTurns={async () => {}}
						onSteer={async () => ({ status: "accepted" })}
					/>
				</Profiler>,
			);
		const first = hugeLiveTurnSnapshot({ items, queued, outputLines, queuedReports, liveStreaming, liveReplyParagraphs, tick: 0 });
		const snapshotBytes = JSON.stringify(first).length;
		const started = performance.now();
		mount(first);
		await document.fonts.ready;
		await wait(500);
		const mountMs = performance.now() - started;
		const scroller = document.querySelector<HTMLElement>(
			'[role="log"][aria-label="Conversation"]',
		)!;
		if (!scroller) throw new Error("Conversation did not mount");
		const domNodes = document.getElementsByTagName("*").length;
		// The spec starts the optional CPU profile here, so mounting is not in it.
		console.debug("ao-perf:profile-start");
		await wait(50);
		const sum = (phaseName: string, key: "actual" | "base") =>
			commits.filter((c) => c.phase === phaseName).reduce((t, c) => t + c[key], 0);

		// 1. Refresh: the live turn gains a little text and the daemon resends it all.
		phase = "refresh";
		const refreshWall: number[] = [];
		for (let tick = 1; runs("refresh") && tick <= refreshes; tick++) {
			const next = refetched(hugeLiveTurnSnapshot({ items, queued, outputLines, queuedReports, liveStreaming, liveReplyParagraphs, tick }));
			const t0 = performance.now();
			mount(next);
			refreshWall.push(performance.now() - t0);
			await frame();
			await wait(50);
		}
		const refreshCommits = commits.filter((c) => c.phase === "refresh");

		// 2. Typing: one character at a time into the real composer.
		phase = "typing";
		const editor = document.querySelector<HTMLElement>(
			'[contenteditable="true"]',
		);
		if (!editor) throw new Error("Composer did not mount");
		editor.focus();
		await wait(100);
		const keystrokeMs: number[] = [];
		for (let index = 0; runs("typing") && index < 40; index++) {
			const t0 = performance.now();
			document.execCommand("insertText", false, "abcdefghij"[index % 10]);
			const handled = performance.now() - t0;
			await frame();
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => resolve();
				channel.port2.postMessage(0);
			});
			keystrokeMs.push(performance.now() - t0);
			void handled;
			await wait(20);
		}
		const typedChars = (editor.textContent ?? "").length;

		// 3. Typing while the live turn refreshes underneath, as in the incident.
		phase = "typing-while-refreshing";
		const busyKeystrokeMs: number[] = [];
		const busyBreakdown: number[][] = [];
		for (let index = 0; runs("typing-while-refreshing") && index < 20; index++) {
			mount(refetched(hugeLiveTurnSnapshot({ items, queued, outputLines, queuedReports, liveStreaming, liveReplyParagraphs, tick: 20 + index })));
			const t0 = performance.now();
			document.execCommand("insertText", false, "x");
			const handledMs = performance.now() - t0;
			await frame();
			const rafMs = performance.now() - t0;
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => resolve();
				channel.port2.postMessage(0);
			});
			busyKeystrokeMs.push(performance.now() - t0);
			busyBreakdown.push([handledMs, rafMs, performance.now() - t0]);
			await wait(20);
		}

		// 3b. The same keystroke while the snapshot is re-sent unchanged: the floor that
		// typing-while-refreshing is measured against, with no live text to re-render.
		phase = "typing-while-unchanged";
		const unchangedKeystrokeMs: number[] = [];
		const unchangedSnapshot = hugeLiveTurnSnapshot({ items, queued, outputLines, queuedReports, liveStreaming, liveReplyParagraphs, tick: 20 });
		for (let index = 0; runs("typing-while-unchanged") && index < 20; index++) {
			mount(refetched(unchangedSnapshot));
			const t0 = performance.now();
			document.execCommand("insertText", false, "x");
			await frame();
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => resolve();
				channel.port2.postMessage(0);
			});
			unchangedKeystrokeMs.push(performance.now() - t0);
			await wait(20);
		}

		// 4. Scrolling through the turn.
		phase = "scroll";
		const frameGaps: number[] = [];
		let last = await frame();
		for (let index = 0; runs("scroll") && index < 120; index++) {
			scroller.scrollTop =
				((scroller.scrollHeight - scroller.clientHeight) * index) / 119;
			scroller.dispatchEvent(new Event("scroll"));
			const now = await frame();
			frameGaps.push(now - last);
			last = now;
		}
		console.debug("ao-perf:profile-stop");
		await wait(50);
		return {
			items,
			queued,
			queuedReports,
			snapshotBytes,
			domNodes,
			mountMs,
			mountedTurns: scroller.querySelectorAll("[data-chat-scroll-anchor]").length,
			refresh: {
				count: refreshCommits.length,
				wallMedianMs: percentile(refreshWall, 0.5),
				commitActualMedianMs: percentile(refreshCommits.map((c) => c.actual), 0.5),
				commitActualMaxMs: Math.max(0, ...refreshCommits.map((c) => c.actual)),
				commitBaseMedianMs: percentile(refreshCommits.map((c) => c.base), 0.5),
				totalActualMs: sum("refresh", "actual"),
				firstCommitsActualMs: refreshCommits.slice(0, 9).map((c) => Math.round(c.actual * 10) / 10),
			},
			typing: {
				typedChars,
				keystrokeMedianMs: percentile(keystrokeMs, 0.5),
				keystrokeP95Ms: percentile(keystrokeMs, 0.95),
				keystrokeMaxMs: Math.max(0, ...keystrokeMs),
				workspaceCommits: commits.filter((c) => c.phase === "typing").length,
				workspaceActualMs: sum("typing", "actual"),
			},
			typingWhileRefreshing: {
				keystrokeMedianMs: percentile(busyKeystrokeMs, 0.5),
				keystrokeP95Ms: percentile(busyKeystrokeMs, 0.95),
				keystrokeMaxMs: Math.max(0, ...busyKeystrokeMs),
				commits: commits.filter((c) => c.phase === "typing-while-refreshing").length,
				commitActualMs: sum("typing-while-refreshing", "actual"),
				medianHandledRafPaintMs: [0, 1, 2].map((column) => percentile(busyBreakdown.map((row) => row[column]!), 0.5)),
			},
			typingWhileUnchanged: {
				keystrokeMedianMs: percentile(unchangedKeystrokeMs, 0.5),
				keystrokeP95Ms: percentile(unchangedKeystrokeMs, 0.95),
				commits: commits.filter((c) => c.phase === "typing-while-unchanged").length,
			},
			scroll: {
				medianFrameGapMs: percentile(frameGaps, 0.5),
				p95FrameGapMs: percentile(frameGaps, 0.95),
				maxFrameGapMs: Math.max(0, ...frameGaps),
			},
		};
	},
};
(
	window as unknown as { performanceHarness: typeof performanceHarness }
).performanceHarness = performanceHarness;
