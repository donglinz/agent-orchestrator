/**
 * Paints in-chat find matches on the DOM that happens to be mounted.
 *
 * Highlights use the CSS Custom Highlight API: ranges are registered by name and
 * styled with `::highlight()`, so painting never edits or re-renders the React tree.
 * Which item and occurrence is "current" comes from the data search; this module
 * only locates the matching text inside that item's element.
 */

export const FIND_HIGHLIGHT = "chat-find";
export const FIND_ACTIVE_HIGHLIGHT = "chat-find-active";
/** Attribute on every rendered item's element, carrying its conversation item id. */
export const FIND_ITEM_ATTRIBUTE = "data-chat-find-id";
/** Painting is capped so a one-letter query over a huge mounted turn stays cheap. */
export const MAX_PAINTED_RANGES = 2_000;

type HighlightRegistry = {
	set(name: string, highlight: unknown): unknown;
	delete(name: string): unknown;
};

function highlightRegistry(): HighlightRegistry | undefined {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	return css?.highlights;
}

function highlightConstructor(): (new (...ranges: Range[]) => unknown) | undefined {
	return (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
}

export function supportsFindHighlights(): boolean {
	return Boolean(highlightRegistry() && highlightConstructor());
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);

/**
 * Every case-insensitive occurrence of `query` inside single text nodes of `root`,
 * in document order. Matches are not joined across element boundaries, so a query
 * spanning bold and plain text is found by the data search but not painted.
 */
export function findTextRanges(root: Element, query: string, limit = MAX_PAINTED_RANGES): Range[] {
	const needle = query.toLowerCase();
	if (!needle.trim()) return [];
	const ranges: Range[] = [];
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || SKIPPED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
			return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = (node.nodeValue ?? "").toLowerCase();
		let from = text.indexOf(needle);
		while (from !== -1) {
			const range = root.ownerDocument.createRange();
			range.setStart(node, from);
			range.setEnd(node, from + needle.length);
			ranges.push(range);
			if (ranges.length >= limit) return ranges;
			from = text.indexOf(needle, from + needle.length);
		}
	}
	return ranges;
}

/** The mounted element for a conversation item, if its row is currently rendered. */
export function findItemElement(root: ParentNode, itemId: string): HTMLElement | null {
	const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
		? CSS.escape(itemId)
		: itemId.replace(/["\\]/g, "\\$&");
	return root.querySelector<HTMLElement>(`[${FIND_ITEM_ATTRIBUTE}="${escaped}"]`);
}

/**
 * The range for one occurrence inside an item, clamped to the last one rendered.
 * The data search and the rendered text can disagree slightly (markdown, truncated
 * previews), so a short item shows its final match rather than none.
 */
export function activeRangeIn(item: Element, query: string, ordinal: number): Range | undefined {
	const ranges = findTextRanges(item, query);
	return ranges[Math.min(ordinal, ranges.length - 1)];
}

export interface PaintedFind {
	/** The current match's range, when its text is rendered. */
	active?: Range;
}

/** Replaces the registered highlights with the ranges for `query` under `root`. */
export function paintFindHighlights(
	root: Element,
	query: string,
	current?: { itemId: string; ordinal: number },
): PaintedFind {
	const registry = highlightRegistry();
	const Highlight = highlightConstructor();
	if (!registry || !Highlight) return {};
	const ranges = findTextRanges(root, query);
	const itemElement = current ? findItemElement(root, current.itemId) : null;
	const active = current && itemElement ? activeRangeIn(itemElement, query, current.ordinal) : undefined;
	if (ranges.length === 0) {
		clearFindHighlights();
		return {};
	}
	registry.set(FIND_HIGHLIGHT, new Highlight(...ranges));
	if (active) registry.set(FIND_ACTIVE_HIGHLIGHT, new Highlight(active));
	else registry.delete(FIND_ACTIVE_HIGHLIGHT);
	return { active };
}

export function clearFindHighlights(): void {
	const registry = highlightRegistry();
	registry?.delete(FIND_HIGHLIGHT);
	registry?.delete(FIND_ACTIVE_HIGHLIGHT);
}

/**
 * Scrolls `scroller` so `target` sits comfortably inside it, doing nothing when it
 * already does. Instant: find navigation should land, not glide.
 */
export function scrollRectIntoView(scroller: HTMLElement, target: { top: number; bottom: number }, padding = 48): boolean {
	const viewport = scroller.getBoundingClientRect();
	if (target.top >= viewport.top + padding && target.bottom <= viewport.bottom - padding) return false;
	if (target.bottom - target.top > viewport.height - padding * 2) {
		// Taller than the viewport: show its start rather than its middle.
		scroller.scrollTop += target.top - (viewport.top + padding);
		return true;
	}
	const center = (target.top + target.bottom) / 2;
	scroller.scrollTop += center - (viewport.top + viewport.height / 2);
	return true;
}

export function rectOf(target: Range | Element): { top: number; bottom: number } | undefined {
	if (typeof target.getBoundingClientRect !== "function") return undefined;
	const rect = target.getBoundingClientRect();
	return { top: rect.top, bottom: rect.bottom };
}
