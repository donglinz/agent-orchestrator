import { act, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";
import { TooltipProvider } from "../ui/tooltip";
import type { ConversationItem, ConversationSnapshot, ConversationTurn } from "../../types/conversation";

// A live turn is refetched every few seconds and arrives as brand-new objects for
// every row. These count what a refresh re-renders: it must cost the rows that
// changed, not the whole turn and the whole queue dock.
const renders = vi.hoisted(() => ({ activityRows: 0, queuedRows: 0 }));

vi.mock("./ChatTimelineItems", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ChatTimelineItems")>();
	return {
		...actual,
		ActivityRow: (props: Parameters<typeof actual.ActivityRow>[0]) => {
			renders.activityRows += 1;
			return actual.ActivityRow(props);
		},
	};
});

vi.mock("./messageAttachments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./messageAttachments")>();
	return {
		...actual,
		// Only a queued row labels its text, once per render.
		labelInlineImages: (...args: Parameters<typeof actual.labelInlineImages>) => {
			renders.queuedRows += 1;
			return actual.labelInlineImages(...args);
		},
	};
});

function render(ui: ReactElement) {
	const result = rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
	return {
		...result,
		rerender: (next: ReactElement) => result.rerender(<TooltipProvider>{next}</TooltipProvider>),
	};
}

const at = (second: number) => new Date(Date.UTC(2026, 9, 14) + second * 1000).toISOString();

/** One running turn of `pairs` reply/command pairs, with `queued` messages waiting behind it. */
function liveTurn(pairs: number, queued: number, extraCommands = 0): ConversationSnapshot {
	const turns: ConversationTurn[] = [{ id: "turn-live", state: "running", requestedAt: at(0), startedAt: at(1) }];
	const items: ConversationItem[] = [];
	let sequence = 0;
	items.push({
		kind: "message", id: "prompt", turnId: "turn-live", sequence: (sequence += 1), revision: 0,
		role: "user", origin: "human", text: "Poll the workers.", streaming: false, delivery: "accepted", createdAt: at(1),
	});
	// Queued sends are recorded as they are typed, ahead of the turn's later work, so
	// their sequences do not move when the turn grows.
	for (let index = 0; index < queued; index += 1) {
		const turnId = `turn-queued-${index}`;
		turns.push({ id: turnId, state: "queued", requestedAt: at(500 + index) });
		items.push({
			kind: "message", id: `queued-${index}`, turnId, sequence: (sequence += 1), revision: 0,
			role: "user", origin: "human", text: `worker report ${index}`, streaming: false, delivery: "queued", createdAt: at(500 + index),
		});
	}
	for (let index = 0; index < pairs + extraCommands; index += 1) {
		// A reply between commands keeps every command its own single-row run.
		items.push({
			kind: "message", id: `reply-${index}`, turnId: "turn-live", sequence: (sequence += 1), revision: 1,
			role: "assistant", origin: "provider", text: `Poll ${index}.`, streaming: false, createdAt: at(2 + index * 2),
		});
		items.push({
			kind: "activity", id: `command-${index}`, turnId: "turn-live", sequence: (sequence += 1), revision: 0,
			activityKind: "command", status: "completed", summary: `ao session ls ${index}`,
			detail: { command: `ao session ls ${index}`, output: "ok", exitCode: 0 }, createdAt: at(3 + index * 2),
		});
	}
	return { ...chatFixture, turns, items, latestSequence: sequence, hasMoreBefore: false };
}

/** What a refetch hands the renderer: equal content, none of the old object identities. */
const refetched = (snapshot: ConversationSnapshot): ConversationSnapshot => JSON.parse(JSON.stringify(snapshot));

// Fresh arrows on every call, as `useConversationCommands` returns them.
const callbacks = () => ({
	onSend: () => {},
	onPromoteQueuedTurn: async () => {},
	onEditQueuedTurn: async () => {},
	onCancelQueuedTurn: async () => {},
	onReorderQueuedTurns: async () => {},
});

describe("a live turn refresh", () => {
	it("re-renders only the rows that changed, not the whole turn", async () => {
		const first = liveTurn(40, 0);
		const view = render(<ChatWorkspace snapshot={first} {...callbacks()} />);
		await act(async () => {});
		expect(renders.activityRows).toBeGreaterThanOrEqual(40);

		renders.activityRows = 0;
		view.rerender(<ChatWorkspace snapshot={refetched(liveTurn(40, 0, 1))} {...callbacks()} />);
		await act(async () => {});

		expect(screen.getByText("Poll 40.")).toBeInTheDocument();
		// The one new command, nothing else.
		expect(renders.activityRows).toBeLessThanOrEqual(2);
	});

	it("leaves the queued dock alone while its messages are unchanged", async () => {
		const view = render(<ChatWorkspace snapshot={liveTurn(5, 6)} {...callbacks()} />);
		await act(async () => {});
		expect(await screen.findByTestId("queued-message-dock")).toBeInTheDocument();
		expect(renders.queuedRows).toBeGreaterThanOrEqual(6);

		renders.queuedRows = 0;
		view.rerender(<ChatWorkspace snapshot={refetched(liveTurn(6, 6))} {...callbacks()} />);
		await act(async () => {});

		expect(screen.getByText("Poll 5.")).toBeInTheDocument();
		expect(renders.queuedRows).toBe(0);
	});

	it("windows the rows of a huge turn but leaves a small turn whole", async () => {
		const small = render(<ChatWorkspace snapshot={liveTurn(5, 0)} {...callbacks()} />);
		await act(async () => {});
		expect(document.querySelectorAll("[data-chat-window-items]")).toHaveLength(0);
		small.unmount();

		render(<ChatWorkspace snapshot={liveTurn(40, 0)} {...callbacks()} />);
		await act(async () => {});
		// Every row of the turn after its prompt, each naming the items it draws.
		const boxes = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-window-items]"));
		expect(boxes).toHaveLength(80);
		expect(boxes.some((box) => box.dataset.chatWindowItems === "reply-39")).toBe(true);
		// The prompt that opened the turn is never windowed.
		expect(boxes.some((box) => box.dataset.chatWindowItems === "prompt")).toBe(false);
	});
});
