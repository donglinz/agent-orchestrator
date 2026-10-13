import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ConversationMessage } from "../../types/conversation";
import { ChatFind, FIND_DEBOUNCE_MS } from "./ChatFind";
import type { ChatFindGroup } from "./chatFindSearch";
import { createChatFindRevealStore } from "./chatFindReveal";

vi.mock("../../lib/platform", () => ({
	isMacPlatform: () => true,
	isLinuxPlatform: () => false,
	isWindowsPlatform: () => false,
}));

let sequence = 0;
function assistant(id: string, text: string): ConversationMessage {
	sequence += 1;
	return {
		kind: "message",
		id,
		sequence,
		revision: 0,
		role: "assistant",
		origin: "provider",
		text,
		streaming: false,
		createdAt: "2026-10-14T00:00:00Z",
	};
}

const items: ConversationItem[] = [
	assistant("a1", "alpha"),
	assistant("a2", "alpha beta alpha"),
	assistant("a3", "gamma"),
];
const groups: ChatFindGroup[] = [
	{ key: "g1", items: [items[0]!] },
	{ key: "g2", items: [items[1]!, items[2]!] },
];

function Harness({
	data = groups,
	hasOlder,
	scrollToGroup,
	viewportGroupIndex = () => 0,
	store,
}: {
	data?: ChatFindGroup[];
	hasOlder?: boolean;
	scrollToGroup: (key: string) => void;
	viewportGroupIndex?: () => number;
	store: ReturnType<typeof createChatFindRevealStore>;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	return (
		<>
			<div data-chat-find-scope="">
				<div ref={rootRef} className="relative">
					<div ref={scrollerRef} role="log">
						<div ref={contentRef}>
							{items.map((item) => (
								<div key={item.id} data-chat-find-id={item.id}>
									{item.kind === "message" ? item.text : ""}
								</div>
							))}
						</div>
					</div>
					<ChatFind
						rootRef={rootRef}
						scrollerRef={scrollerRef}
						contentRef={contentRef}
						groups={data}
						hasOlder={hasOlder}
						revealStore={store}
						scrollToGroup={scrollToGroup}
						viewportGroupIndex={viewportGroupIndex}
					/>
				</div>
				<textarea aria-label="Composer" />
				<div className="xterm">
					<textarea aria-label="Embedded terminal" />
				</div>
			</div>
			<input aria-label="Other panel field" />
		</>
	);
}

function setup(props: Partial<Parameters<typeof Harness>[0]> = {}) {
	const store = createChatFindRevealStore();
	const reveal = vi.spyOn(store, "reveal");
	const scrollToGroup = vi.fn();
	render(<Harness scrollToGroup={scrollToGroup} store={store} {...props} />);
	return { store, reveal, scrollToGroup };
}

const cmd = (key: string, init: KeyboardEventInit = {}) => ({ key, metaKey: true, ...init });

async function openAndType(text: string) {
	const composer = screen.getByLabelText("Composer");
	composer.focus();
	fireEvent.keyDown(composer, cmd("f"));
	const input = await screen.findByRole("textbox", { name: "Find in chat" });
	await userEvent.type(input, text);
	return { composer, input };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ChatFind keyboard", () => {
	it("opens on Cmd+F from inside the chat and focuses the field", async () => {
		setup();
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		const notPrevented = fireEvent.keyDown(composer, cmd("f"));
		expect(notPrevented).toBe(false);
		const input = await screen.findByRole("textbox", { name: "Find in chat" });
		expect(input).toHaveFocus();
		expect(screen.getByRole("search", { name: "Find in chat" })).toBeInTheDocument();
	});

	it("does not take Cmd+F from a terminal inside the chat or from another panel", () => {
		setup();
		const terminal = screen.getByLabelText("Embedded terminal");
		terminal.focus();
		expect(fireEvent.keyDown(terminal, cmd("f"))).toBe(true);
		const other = screen.getByLabelText("Other panel field");
		other.focus();
		expect(fireEvent.keyDown(other, cmd("f"))).toBe(true);
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
	});

	it("opens from the page body only right after a click inside the chat", async () => {
		setup();
		(document.activeElement as HTMLElement | null)?.blur();
		fireEvent.keyDown(document.body, cmd("f"));
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();

		fireEvent.pointerDown(screen.getByText("gamma"));
		fireEvent.keyDown(document.body, cmd("f"));
		expect(await screen.findByTestId("chat-find-bar")).toBeInTheDocument();
	});

	it("forgets the chat once focus moves to another panel", () => {
		setup();
		fireEvent.pointerDown(screen.getByText("gamma"));
		screen.getByLabelText("Other panel field").focus();
		(document.activeElement as HTMLElement).blur();
		fireEvent.keyDown(document.body, cmd("f"));
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
	});

	it("ignores Ctrl+F on macOS, Alt-modified and Shift+F presses", () => {
		setup();
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		expect(fireEvent.keyDown(composer, { key: "f", ctrlKey: true })).toBe(true);
		expect(fireEvent.keyDown(composer, cmd("f", { altKey: true }))).toBe(true);
		expect(fireEvent.keyDown(composer, cmd("f", { shiftKey: true }))).toBe(true);
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
	});

	it("only steps with Cmd+G once find is open", async () => {
		setup();
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		expect(fireEvent.keyDown(composer, cmd("g"))).toBe(true);
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
	});
});

describe("ChatFind search and stepping", () => {
	it("debounces typing, counts matches, and lands on the first one", async () => {
		const { scrollToGroup, reveal } = setup();
		await openAndType("ALPHA");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 3"));
		expect(scrollToGroup).toHaveBeenCalledWith("g1");
		expect(reveal).toHaveBeenCalledWith("a1");
	});

	it("does not search on every keystroke", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { scrollToGroup } = setup();
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		fireEvent.keyDown(composer, cmd("f"));
		const input = screen.getByRole("textbox", { name: "Find in chat" });
		fireEvent.change(input, { target: { value: "a" } });
		fireEvent.change(input, { target: { value: "al" } });
		fireEvent.change(input, { target: { value: "alp" } });
		expect(scrollToGroup).not.toHaveBeenCalled();
		expect(screen.getByTestId("chat-find-count")).toHaveTextContent("");
		await act(async () => {
			vi.advanceTimersByTime(FIND_DEBOUNCE_MS + 10);
		});
		expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 3");
		expect(scrollToGroup).toHaveBeenCalledTimes(1);
	});

	it("steps with Enter and Shift+Enter, wrapping at both ends", async () => {
		const { reveal } = setup();
		const { input } = await openAndType("alpha");
		const count = screen.getByTestId("chat-find-count");
		await waitFor(() => expect(count).toHaveTextContent("1 of 3"));
		await act(async () => {}); // let the first-match navigation effect settle

		fireEvent.keyDown(input, { key: "Enter" });
		expect(count).toHaveTextContent("2 of 3");
		expect(reveal).toHaveBeenLastCalledWith("a2");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(count).toHaveTextContent("3 of 3");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(count).toHaveTextContent("1 of 3");
		expect(reveal).toHaveBeenLastCalledWith("a1");
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(count).toHaveTextContent("3 of 3");
	});

	it("jumps to the first match when it arrives after a search that had none", async () => {
		const store = createChatFindRevealStore();
		const reveal = vi.spyOn(store, "reveal");
		const scrollToGroup = vi.fn();
		const view = render(<Harness data={[]} scrollToGroup={scrollToGroup} store={store} />);
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		fireEvent.keyDown(composer, cmd("f"));
		await userEvent.type(await screen.findByRole("textbox", { name: "Find in chat" }), "alpha");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("No results"));
		expect(reveal).not.toHaveBeenCalled();

		view.rerender(<Harness scrollToGroup={scrollToGroup} store={store} />);
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 3"));
		await waitFor(() => expect(reveal).toHaveBeenLastCalledWith("a1"));
	});

	it("keeps the current match when only spaces around the query change", async () => {
		const { reveal, scrollToGroup } = setup();
		const { input } = await openAndType("alpha");
		const count = screen.getByTestId("chat-find-count");
		await waitFor(() => expect(count).toHaveTextContent("1 of 3"));
		await act(async () => {});
		fireEvent.keyDown(input, { key: "Enter" });
		expect(count).toHaveTextContent("2 of 3");
		const reveals = reveal.mock.calls.length;
		const scrolls = scrollToGroup.mock.calls.length;

		await userEvent.type(input, " ");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, FIND_DEBOUNCE_MS + 60));
		});
		expect(input).toHaveValue("alpha ");
		expect(count).toHaveTextContent("2 of 3");
		expect(reveal.mock.calls.length).toBe(reveals);
		expect(scrollToGroup.mock.calls.length).toBe(scrolls);
	});

	it("steps with Cmd+G and Shift+Cmd+G from the field and from the chat", async () => {
		setup();
		const { input, composer } = await openAndType("alpha");
		const count = screen.getByTestId("chat-find-count");
		await waitFor(() => expect(count).toHaveTextContent("1 of 3"));
		await act(async () => {}); // let the first-match navigation effect settle
		fireEvent.keyDown(input, cmd("g"));
		expect(count).toHaveTextContent("2 of 3");
		fireEvent.keyDown(input, cmd("g", { shiftKey: true }));
		expect(count).toHaveTextContent("1 of 3");
		composer.focus();
		fireEvent.keyDown(composer, cmd("g"));
		expect(count).toHaveTextContent("2 of 3");
	});

	it("uses the previous and next buttons", async () => {
		setup();
		await openAndType("alpha");
		const count = screen.getByTestId("chat-find-count");
		await waitFor(() => expect(count).toHaveTextContent("1 of 3"));
		await act(async () => {}); // let the first-match navigation effect settle
		await userEvent.click(screen.getByRole("button", { name: "Next match" }));
		expect(count).toHaveTextContent("2 of 3");
		await userEvent.click(screen.getByRole("button", { name: "Previous match" }));
		expect(count).toHaveTextContent("1 of 3");
	});

	it("flushes a pending debounce on Enter", async () => {
		const { reveal } = setup();
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		fireEvent.keyDown(composer, cmd("f"));
		const input = screen.getByRole("textbox", { name: "Find in chat" });
		fireEvent.change(input, { target: { value: "gamma" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 1"));
		expect(reveal).toHaveBeenCalledWith("a3");
	});

	it("starts from the first match at or below the reader's position", async () => {
		const { reveal } = setup({ viewportGroupIndex: () => 1 });
		await openAndType("alpha");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("2 of 3"));
		expect(reveal).toHaveBeenLastCalledWith("a2");
	});

	it("says so when nothing matches and disables stepping", async () => {
		setup();
		await openAndType("zzz");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("No results"));
		expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
	});

	it("marks the count as a lower bound while older history is unloaded", async () => {
		setup({ hasOlder: true });
		await openAndType("alpha");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 3+"));
	});
});

describe("ChatFind closing", () => {
	it("closes on Escape and returns focus to where it was", async () => {
		const { store } = setup();
		const clear = vi.spyOn(store, "clear");
		const { composer, input } = await openAndType("alpha");
		await waitFor(() => expect(screen.getByTestId("chat-find-count")).toHaveTextContent("1 of 3"));
		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
		expect(composer).toHaveFocus();
		expect(clear).toHaveBeenCalled();
	});

	it("closes from the close button", async () => {
		setup();
		const { composer } = await openAndType("alpha");
		await userEvent.click(screen.getByRole("button", { name: "Close find" }));
		expect(screen.queryByTestId("chat-find-bar")).not.toBeInTheDocument();
		expect(composer).toHaveFocus();
	});

	it("keeps the bar's keys from reaching the rest of the chat", async () => {
		setup();
		const seen = vi.fn();
		document.addEventListener("keydown", seen);
		const { input } = await openAndType("alpha");
		seen.mockClear();
		fireEvent.keyDown(input, { key: "Escape" });
		document.removeEventListener("keydown", seen);
		expect(seen).not.toHaveBeenCalled();
	});

	it("selects the field again instead of closing when Cmd+F is pressed while open", async () => {
		setup();
		const { composer, input } = await openAndType("alpha");
		composer.focus();
		fireEvent.keyDown(composer, cmd("f"));
		expect(screen.getByTestId("chat-find-bar")).toBeInTheDocument();
		await waitFor(() => expect(input).toHaveFocus());
		const field = input as HTMLInputElement;
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe(5);
	});

	it("starts empty when reopened", async () => {
		setup();
		const { input } = await openAndType("alpha");
		fireEvent.keyDown(input, { key: "Escape" });
		const composer = screen.getByLabelText("Composer");
		composer.focus();
		fireEvent.keyDown(composer, cmd("f"));
		expect(await screen.findByRole("textbox", { name: "Find in chat" })).toHaveValue("");
	});
});
