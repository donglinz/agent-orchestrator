import { describe, expect, it } from "vitest";
import type { ConversationActivity, ConversationItem, ConversationMessage } from "../../types/conversation";
import {
	EMPTY_FIND_RESULT,
	type ChatFindGroup,
	findShortcutOf,
	findableText,
	firstMatchFromGroup,
	indexOfMatch,
	locateMatch,
	markdownVisibleText,
	searchChatItems,
	stepMatch,
} from "./chatFindSearch";
import { findItemRanges } from "./chatFindHighlight";

let sequence = 0;

function message(id: string, text: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
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
		...overrides,
	};
}

function human(id: string, text: string): ConversationMessage {
	return message(id, text, { role: "user", origin: "human" });
}

function activity(id: string, summary: string, overrides: Partial<ConversationActivity> = {}): ConversationActivity {
	sequence += 1;
	return {
		kind: "activity",
		id,
		sequence,
		revision: 0,
		activityKind: "command",
		status: "completed",
		summary,
		createdAt: "2026-10-14T00:00:00Z",
		...overrides,
	};
}

const group = (key: string, ...items: ConversationItem[]): ChatFindGroup => ({ key, items });

describe("searchChatItems", () => {
	it("gives the same count and painted ranges for queries that differ only in spaces", () => {
		// The rendered DOM keeps its original spacing; the data search collapses it.
		const texts = ["foo bar and Foo  bar", "FOO\nbar", "foo", "foo baz"];
		const items = texts.map((text, index) => human(`m${index}`, text));
		const root = document.createElement("div");
		for (const [index, text] of texts.entries()) {
			const node = document.createElement("div");
			node.setAttribute("data-chat-find-id", `m${index}`);
			node.textContent = text;
			root.append(node);
		}
		const outcome = (query: string) => ({
			total: searchChatItems([group("g", ...items)], query).total,
			painted: findItemRanges(root, query).map((range) => range.toString()),
		});
		const expected = outcome("foo bar");
		expect(expected.total).toBe(3);
		expect(expected.painted).toEqual(["foo bar", "Foo  bar", "FOO\nbar"]);
		for (const variant of ["foo bar ", " foo bar", "  FOO   bar  ", "foo\tbar"]) {
			expect(outcome(variant)).toEqual(expected);
		}
		const single = outcome("foo");
		for (const variant of ["foo ", " foo", "  foo  "]) {
			expect(outcome(variant)).toEqual(single);
		}
		expect(single.total).toBe(single.painted.length);
		expect(outcome("   ")).toEqual({ total: 0, painted: [] });
	});

	it("ignores spaces around the query, so a trailing space changes nothing", () => {
		const items = [human("a", "the quick fox"), human("b", "quick")];
		const total = (query: string) => searchChatItems([group("g", ...items)], query).total;
		expect(total("quick")).toBe(2);
		expect(total("quick ")).toBe(2);
		expect(total("  quick")).toBe(2);
		expect(total("the   quick ")).toBe(1);
	});

	it("is case-insensitive and counts every occurrence in timeline order", () => {
		const result = searchChatItems(
			[
				group("g1", human("h1", "Find the Needle"), message("a1", "needle needle and NEEDLE")),
				group("g2", activity("c1", "Ran needle search")),
			],
			"NeEdLe",
		);
		expect(result.total).toBe(5);
		expect(result.hits).toEqual([
			{ itemId: "h1", groupKey: "g1", count: 1, start: 0 },
			{ itemId: "a1", groupKey: "g1", count: 3, start: 1 },
			{ itemId: "c1", groupKey: "g2", count: 1, start: 4 },
		]);
	});

	it("returns the shared empty result for a blank query", () => {
		expect(searchChatItems([group("g", message("a", "text"))], "")).toBe(EMPTY_FIND_RESULT);
		expect(searchChatItems([group("g", message("a", "text"))], "   ")).toBe(EMPTY_FIND_RESULT);
	});

	it("does not count overlapping occurrences twice", () => {
		expect(searchChatItems([group("g", message("a", "aaaa"))], "aa").total).toBe(2);
	});

	it("matches across whitespace differences in the data", () => {
		const result = searchChatItems([group("g", message("a", "alpha\n\n  beta"))], "alpha beta");
		expect(result.total).toBe(1);
	});

	it("never matches the hidden worker report envelope on a human message", () => {
		const text =
			"Please continue\n\n<ao-worker-reports>\nReports since your previous turn:\n\n[done] worker\nFinished secretword\n</ao-worker-reports>";
		expect(searchChatItems([group("g", human("h", text))], "secretword").total).toBe(0);
		expect(searchChatItems([group("g", human("h", text))], "continue").total).toBe(1);
	});

	it("ignores rows the timeline draws nothing for", () => {
		const items = [
			activity("pending", "Allow secret command", { activityKind: "approval", status: "pending" }),
			activity("input", "secret question", { activityKind: "user_input", status: "pending" }),
			activity("usage", "secret usage", { activityKind: "usage" }),
			activity("compact", "secret compaction", { detail: { event: "compaction" } }),
		];
		expect(searchChatItems([group("g", ...items)], "secret").total).toBe(0);
	});

	it("keeps resolved approvals and ordinary tool summaries searchable", () => {
		const items = [
			activity("done", "Approved secret command", { activityKind: "approval", status: "resolved" }),
			activity("tool", "Edited secret.ts", { activityKind: "file_change" }),
		];
		expect(searchChatItems([group("g", ...items)], "secret").total).toBe(2);
	});

	it("searches a command's own text but not its output", () => {
		const item = activity("c", "Ran tests", {
			activityKind: "command",
			detail: { command: "go test ./commandword", output: "outputword" },
		});
		expect(searchChatItems([group("g", item)], "commandword").total).toBe(1);
		expect(searchChatItems([group("g", item)], "outputword").total).toBe(0);
	});

	it("searches the paths of a file change", () => {
		const item = activity("f", "Edited 2 files", {
			activityKind: "file_change",
			detail: { files: [{ path: "src/pathword.ts", status: "modified", additions: 1, deletions: 0 }, { path: "b.ts", status: "added", additions: 2, deletions: 0 }] },
		});
		expect(searchChatItems([group("g", item)], "pathword").total).toBe(1);
	});

	it("searches a steer's own words, not its sender prefix attachments", () => {
		const steer = activity("s", "Steered", {
			activityKind: "system",
			detail: { event: "steer", text: "please also check the logs" },
		});
		expect(searchChatItems([group("g", steer)], "check the logs").total).toBe(1);
		const withReport = activity("s2", "Steered", {
			activityKind: "system",
			detail: {
				event: "steer",
				text: "go on\n\n<ao-worker-reports>\nenvelopeword\n</ao-worker-reports>",
			},
		});
		expect(searchChatItems([group("g", withReport)], "go on").total).toBe(1);
		expect(searchChatItems([group("g", withReport)], "envelopeword").total).toBe(0);
	});

	it("ignores markdown syntax the reader cannot see", () => {
		const text = "See [the guide](https://example.com/hidden-slug) and **bold** `code`";
		const groups = [group("g", message("a", text))];
		expect(searchChatItems(groups, "hidden-slug").total).toBe(0);
		expect(searchChatItems(groups, "the guide").total).toBe(1);
		expect(searchChatItems(groups, "bold code").total).toBe(1);
	});

	it("stays fast over a very long chat", () => {
		const groups: ChatFindGroup[] = [];
		for (let turn = 0; turn < 300; turn += 1) {
			const items: ConversationItem[] = [human(`h${turn}`, `question number ${turn}`)];
			for (let call = 0; call < 3; call += 1) items.push(activity(`a${turn}-${call}`, `Ran command ${call} for turn ${turn}`));
			items.push(message(`r${turn}`, `Answer ${turn}: ${"lorem ipsum dolor sit amet ".repeat(40)}`));
			groups.push(group(`g${turn}`, ...items));
		}
		// A live turn with 900 rows of activity.
		groups.push(group("live", ...Array.from({ length: 900 }, (_, index) => activity(`live-${index}`, `Reading file ${index}`))));
		const warm = searchChatItems(groups, "lorem");
		expect(warm.total).toBe(300 * 40);
		const started = performance.now();
		const again = searchChatItems(groups, "file 8");
		const elapsed = performance.now() - started;
		expect(again.total).toBe(111);
		// Generous: a cold-cache scan of ~2k items is milliseconds; this guards against O(n^2) regressions.
		expect(elapsed).toBeLessThan(250);
	});
});

describe("findableText", () => {
	it("uses the visible body of a human message", () => {
		expect(findableText(human("h", "hello\n\n<ao-worker-reports>\nx\n</ao-worker-reports>"))).toBe("hello");
	});
});

describe("markdownVisibleText", () => {
	it("drops fences, link targets, emphasis, headings and bullets", () => {
		const text = "# Title\n\n- item [link](http://x.y)\n\n```ts\ncode\n```\n> quote";
		expect(markdownVisibleText(text)).toContain("Title");
		expect(markdownVisibleText(text)).toContain("item link");
		expect(markdownVisibleText(text)).toContain("code");
		expect(markdownVisibleText(text)).toContain("quote");
		expect(markdownVisibleText(text)).not.toContain("http://x.y");
		expect(markdownVisibleText(text)).not.toContain("```");
		expect(markdownVisibleText(text)).not.toContain("#");
	});
});

describe("markdownVisibleText code and syntax", () => {
	const total = (text: string, query: string) =>
		searchChatItems([group("g", message("m", text))], query).total;

	it("keeps the literal contents of fenced code", () => {
		const text = "Here:\n\n```python\nresult = 2 ** 3\nname = '__x__'\n# not a heading\n- not a bullet\n[a](b)\n```\n";
		expect(total(text, "2 ** 3")).toBe(1);
		expect(total(text, "2 3")).toBe(0);
		expect(total(text, "'__x__'")).toBe(1);
		expect(total(text, "# not a heading")).toBe(1);
		expect(total(text, "- not a bullet")).toBe(1);
		expect(total(text, "[a](b)")).toBe(1);
		expect(total(text, "python")).toBe(0);
		expect(total(text, "```")).toBe(0);
	});

	it("keeps the literal contents of inline code", () => {
		const text = "Use `a ** b` and `~~keep~~` and `**bold?**` here.";
		expect(total(text, "a ** b")).toBe(1);
		expect(total(text, "~~keep~~")).toBe(1);
		expect(total(text, "**bold?**")).toBe(1);
		expect(total(text, "`")).toBe(0);
	});

	it("still strips real markup outside code", () => {
		const text = "## Title\n\n**bold** and ~~gone~~ and [site](https://example.com/x) ![alt text](img.png)\n\n1. first\n2. second\n\n> quoted";
		expect(markdownVisibleText(text)).toContain("bold and gone and site alt text");
		for (const absent of ["##", "**", "~~", "https://example.com/x", "img.png", "1.", ">"]) {
			expect(markdownVisibleText(text)).not.toContain(absent);
		}
		for (const present of ["Title", "first", "second", "quoted"]) {
			expect(markdownVisibleText(text)).toContain(present);
		}
	});

	it("reads footnote bodies and reference-image alt text, which the transcript renders", () => {
		const text = "Claim[^1] and ![diagram alt][pic]\n\n[^1]: The footnote body.\n\n[pic]: https://example.com/pic.png";
		expect(total(text, "footnote body")).toBe(1);
		expect(total(text, "diagram alt")).toBe(1);
		expect(total(text, "example.com")).toBe(0);
		expect(total(text, "[^1]")).toBe(0);
	});

	it("reads table cells as text", () => {
		expect(total("| a | b |\n| - | - |\n| needle | 2 |", "needle")).toBe(1);
		expect(total("| a | b |\n| - | - |\n| needle | 2 |", "|")).toBe(0);
	});

	it("keeps words from adjacent blocks apart", () => {
		expect(total("first line\n\nsecond line", "line second")).toBe(1);
		expect(total("one\n\ntwo", "onetwo")).toBe(0);
	});
});

describe("match navigation helpers", () => {
	const result = searchChatItems(
		[group("g1", message("a", "x x"), message("b", "x")), group("g2", message("c", "x x x"))],
		"x",
	);

	it("locates a global index inside its item", () => {
		expect(locateMatch(result, 0)).toMatchObject({ hit: { itemId: "a" }, ordinal: 0 });
		expect(locateMatch(result, 1)).toMatchObject({ hit: { itemId: "a" }, ordinal: 1 });
		expect(locateMatch(result, 2)).toMatchObject({ hit: { itemId: "b" }, ordinal: 0 });
		expect(locateMatch(result, 5)).toMatchObject({ hit: { itemId: "c" }, ordinal: 2 });
		expect(locateMatch(result, 6)).toBeUndefined();
		expect(locateMatch(result, -1)).toBeUndefined();
	});

	it("round-trips an item occurrence to its index, clamping a shrunken item", () => {
		expect(indexOfMatch(result, "c", 1)).toBe(4);
		expect(indexOfMatch(result, "c", 9)).toBe(5);
		expect(indexOfMatch(result, "missing", 0)).toBeUndefined();
	});

	it("steps forward and backward with wraparound", () => {
		expect(stepMatch(5, 6, 1)).toBe(0);
		expect(stepMatch(0, 6, -1)).toBe(5);
		expect(stepMatch(2, 6, 1)).toBe(3);
		expect(stepMatch(0, 0, 1)).toBe(-1);
	});

	it("starts at the first match at or below the reader, wrapping to the top", () => {
		const groups = [group("g1"), group("g2"), group("g3")];
		const spread = searchChatItems(
			[group("g1", message("a", "x")), group("g3", message("c", "x x"))],
			"x",
		);
		expect(firstMatchFromGroup(spread, groups, 0)).toBe(0);
		expect(firstMatchFromGroup(spread, groups, 1)).toBe(1);
		expect(firstMatchFromGroup(spread, groups, 2)).toBe(1);
		const onlyTop = searchChatItems([group("g1", message("a", "x"))], "x");
		expect(firstMatchFromGroup(onlyTop, groups, 2)).toBe(0);
		expect(firstMatchFromGroup(EMPTY_FIND_RESULT, groups, 0)).toBe(-1);
	});
});

describe("findShortcutOf", () => {
	const key = (init: Partial<Parameters<typeof findShortcutOf>[0]>) => ({
		key: "",
		code: "",
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...init,
	});

	it("maps Cmd+F, Cmd+G and Shift+Cmd+G on macOS", () => {
		expect(findShortcutOf(key({ key: "f", metaKey: true }), true)).toBe("open");
		expect(findShortcutOf(key({ key: "g", metaKey: true }), true)).toBe("next");
		expect(findShortcutOf(key({ key: "G", metaKey: true, shiftKey: true }), true)).toBe("previous");
	});

	it("maps Ctrl+F and Ctrl+G elsewhere", () => {
		expect(findShortcutOf(key({ key: "f", ctrlKey: true }), false)).toBe("open");
		expect(findShortcutOf(key({ key: "g", ctrlKey: true, shiftKey: true }), false)).toBe("previous");
	});

	it("leaves the wrong modifier, Alt and Shift+F alone", () => {
		expect(findShortcutOf(key({ key: "f", ctrlKey: true }), true)).toBeUndefined();
		expect(findShortcutOf(key({ key: "f", metaKey: true }), false)).toBeUndefined();
		expect(findShortcutOf(key({ key: "f", metaKey: true, ctrlKey: true }), true)).toBeUndefined();
		expect(findShortcutOf(key({ key: "f", metaKey: true, altKey: true }), true)).toBeUndefined();
		expect(findShortcutOf(key({ key: "F", metaKey: true, shiftKey: true }), true)).toBeUndefined();
		expect(findShortcutOf(key({ key: "k", metaKey: true }), true)).toBeUndefined();
	});

	it("falls back to the physical key on non-Latin layouts", () => {
		expect(findShortcutOf(key({ key: "а", code: "KeyF", metaKey: true }), true)).toBe("open");
	});
});
