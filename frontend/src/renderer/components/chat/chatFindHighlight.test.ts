import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FIND_ACTIVE_HIGHLIGHT,
	FIND_HIGHLIGHT,
	activeRangeIn,
	clearFindHighlights,
	findItemElement,
	findItemRanges,
	findTextRanges,
	paintFindHighlights,
	scrollRectIntoView,
	supportsFindHighlights,
} from "./chatFindHighlight";

class FakeHighlight {
	ranges: Range[];
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}

let registry: Map<string, FakeHighlight>;

beforeEach(() => {
	registry = new Map();
	Object.assign(globalThis, {
		Highlight: FakeHighlight,
		CSS: { ...(globalThis.CSS ?? {}), highlights: registry },
	});
	document.body.innerHTML = "";
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, "Highlight");
	Object.assign(globalThis, { CSS: { highlights: undefined } });
});

function transcript() {
	const root = document.createElement("div");
	root.innerHTML = `
		<div data-chat-find-id="one"><p>Alpha beta ALPHA</p></div>
		<div data-chat-find-id="two"><p>no match</p><p>alpha again</p></div>
		<script>alpha in a script</script>
	`;
	document.body.append(root);
	return root;
}

describe("findTextRanges", () => {
	it("finds case-insensitive occurrences in document order", () => {
		const ranges = findTextRanges(transcript(), "ALPHA");
		expect(ranges.map((range) => range.toString())).toEqual(["Alpha", "ALPHA", "alpha"]);
	});

	it("matches the same needle as the data search, ignoring surrounding spaces", () => {
		const ranges = findTextRanges(transcript(), "  alpha ");
		expect(ranges.map((range) => range.toString())).toEqual(["Alpha", "ALPHA", "alpha"]);
	});

	it("skips script content and blank queries", () => {
		expect(findTextRanges(transcript(), "in a script")).toEqual([]);
		expect(findTextRanges(transcript(), "  ")).toEqual([]);
	});

	it("honours the range limit", () => {
		expect(findTextRanges(transcript(), "a", 2)).toHaveLength(2);
	});
});

describe("item lookup", () => {
	it("finds a mounted item element by id, including ids needing escapes", () => {
		const root = document.createElement("div");
		root.innerHTML = `<div data-chat-find-id='odd"id:1'></div>`;
		expect(findItemElement(root, 'odd"id:1')).not.toBeNull();
		expect(findItemElement(root, "missing")).toBeNull();
	});

	it("picks the requested occurrence inside an item and clamps to the last", () => {
		const root = transcript();
		const item = findItemElement(root, "one")!;
		expect(activeRangeIn(item, "alpha", 0)?.toString()).toBe("Alpha");
		expect(activeRangeIn(item, "alpha", 1)?.toString()).toBe("ALPHA");
		expect(activeRangeIn(item, "alpha", 9)?.toString()).toBe("ALPHA");
		expect(activeRangeIn(item, "zzz", 0)).toBeUndefined();
	});
});

describe("paintFindHighlights", () => {
	it("registers all matches and the current one", () => {
		expect(supportsFindHighlights()).toBe(true);
		const root = transcript();
		const painted = paintFindHighlights(root, "alpha", { itemId: "two", ordinal: 0 });
		expect(registry.get(FIND_HIGHLIGHT)?.ranges).toHaveLength(3);
		expect(registry.get(FIND_ACTIVE_HIGHLIGHT)?.ranges.map((range) => range.toString())).toEqual(["alpha"]);
		expect(painted.active?.toString()).toBe("alpha");
	});

	it("paints only inside items, not the timeline chrome between them", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<button>Load earlier messages</button>
			<div data-chat-find-id="turn"><span>Worked for 4s</span><div data-chat-find-id="turn"><p>look for it</p></div></div>
			<span>Worked for 9s</span>
		`;
		document.body.append(root);
		paintFindHighlights(root, "for");
		const painted = registry.get(FIND_HIGHLIGHT)?.ranges.map((range) => range.startContainer.nodeValue);
		// "Worked for 4s" and "look for it" belong to the item; the chrome does not.
		expect(painted).toEqual(["Worked for 4s", "look for it"]);
		expect(findItemRanges(root, "load")).toEqual([]);
	});

	it("drops the current highlight when its item is not mounted", () => {
		const root = transcript();
		paintFindHighlights(root, "alpha", { itemId: "two", ordinal: 0 });
		paintFindHighlights(root, "alpha", { itemId: "offscreen", ordinal: 0 });
		expect(registry.has(FIND_HIGHLIGHT)).toBe(true);
		expect(registry.has(FIND_ACTIVE_HIGHLIGHT)).toBe(false);
	});

	it("clears everything when nothing is mounted or the bar closes", () => {
		const root = transcript();
		paintFindHighlights(root, "alpha");
		paintFindHighlights(root, "nothing-here");
		expect(registry.size).toBe(0);
		paintFindHighlights(root, "alpha");
		clearFindHighlights();
		expect(registry.size).toBe(0);
	});

	it("is a no-op without the Custom Highlight API", () => {
		Reflect.deleteProperty(globalThis, "Highlight");
		expect(supportsFindHighlights()).toBe(false);
		expect(paintFindHighlights(transcript(), "alpha")).toEqual({});
	});
});

describe("scrollRectIntoView", () => {
	function scroller() {
		const node = document.createElement("div");
		node.getBoundingClientRect = () => ({ top: 100, bottom: 600, height: 500, left: 0, right: 400, width: 400, x: 0, y: 100, toJSON: () => ({}) });
		node.scrollTop = 1000;
		return node;
	}

	it("leaves a comfortably visible target alone", () => {
		const node = scroller();
		expect(scrollRectIntoView(node, { top: 300, bottom: 320 })).toBe(false);
		expect(node.scrollTop).toBe(1000);
	});

	it("centers an off-screen target", () => {
		const node = scroller();
		expect(scrollRectIntoView(node, { top: 900, bottom: 920 })).toBe(true);
		expect(node.scrollTop).toBe(1000 + 910 - 350);
	});

	it("aligns the start of a target taller than the viewport", () => {
		const node = scroller();
		expect(scrollRectIntoView(node, { top: 800, bottom: 2000 })).toBe(true);
		expect(node.scrollTop).toBe(1000 + 800 - 148);
	});
});
