import type { Element, ElementContent, Root } from "hast";

/**
 * Fades streamed text in: the characters that arrived in one render are wrapped in
 * one `<span class="stream-char">`, so CSS can fade them in as they mount. Characters
 * that arrive in the same render start fading together, so one span per render looks
 * the same as one span per character, at a fraction of the elements to create and
 * diff on every update. Earlier characters keep their spans (react-markdown keys
 * them by position), so they never replay the animation. Apply only while
 * streaming; a settled reply drops the plugin and renders plain markdown again,
 * instead of keeping a node per update.
 *
 * Which characters arrived together is state, so a caller that renders the same
 * message repeatedly passes a `FadeLedger` and keeps it for the life of the
 * message. Without one every character is its own span, as if each had arrived
 * alone.
 *
 * Bounds, so a long reply cannot make every update expensive or unsafe:
 *   - only the last block is wrapped — text streams in at the tail, and earlier
 *     blocks have already faded;
 *   - a block over MAX_BLOCK_CHARS is left plain;
 *   - code is skipped, and so are emoji: `compactEmoji` in ChatMarkdown needs to
 *     see them as plain strings;
 *   - any failure leaves the tree untouched, so the reply still renders.
 */
const MAX_BLOCK_CHARS = 4000;
const SKIP = new Set(["pre", "code"]);
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;

type Parent = { children: ElementContent[] };

/**
 * What one streaming message has already shown: which block is streaming and the
 * cumulative grapheme counts at which each render's text ended. Idempotent for the
 * same text, so a repeated render of an unchanged message adds nothing.
 */
export interface FadeLedger {
	block?: string;
	boundaries: number[];
}

export const createFadeLedger = (): FadeLedger => ({ boundaries: [] });

function charSpan(text: string): Element {
	return {
		type: "element",
		tagName: "span",
		properties: { className: ["stream-char"] },
		children: [{ type: "text", value: text }],
	};
}

function textLength(parent: Parent): number {
	let length = 0;
	for (const child of parent.children) {
		if (child.type === "text") length += child.value.length;
		else if (child.type === "element") length += textLength(child);
	}
	return length;
}

/** Graphemes `wrap` will visit, in the order it visits them. */
function graphemeCount(parent: Parent): number {
	let count = 0;
	for (const child of parent.children) {
		if (child.type === "text") {
			if (child.value.trim() !== "") for (const _ of SEGMENTER.segment(child.value)) count++;
		} else if (child.type === "element" && !SKIP.has(child.tagName)) count += graphemeCount(child);
	}
	return count;
}

function record(ledger: FadeLedger, tail: Element, total: number): number[] {
	const block = `${tail.tagName}@${tail.position?.start.offset ?? -1}`;
	if (ledger.block !== block) {
		ledger.block = block;
		ledger.boundaries = [total];
		return ledger.boundaries;
	}
	// Text only grows while a block streams; a shorter block means the parse changed under it.
	while (ledger.boundaries.length > 0 && ledger.boundaries[ledger.boundaries.length - 1]! > total) ledger.boundaries.pop();
	if (ledger.boundaries.at(-1) !== total) ledger.boundaries.push(total);
	return ledger.boundaries;
}

function wrap(parent: Parent, cursor: { position: number; chunk: number }, boundaries: number[] | undefined) {
	parent.children = parent.children.flatMap((child): ElementContent[] => {
		// Whitespace-only text is structural (between table rows, list items).
		if (child.type === "text") {
			if (child.value.trim() === "") return [child];
			const out: ElementContent[] = [];
			let run = "";
			let runChunk = -1;
			const flush = () => {
				if (run) out.push(charSpan(run));
				run = "";
			};
			for (const { segment } of SEGMENTER.segment(child.value)) {
				if (EMOJI_GRAPHEME.test(segment)) {
					flush();
					out.push({ type: "text", value: segment });
				} else {
					let chunk = cursor.position;
					if (boundaries) {
						while (cursor.chunk < boundaries.length - 1 && boundaries[cursor.chunk]! <= cursor.position) cursor.chunk++;
						chunk = cursor.chunk;
					}
					if (chunk !== runChunk) flush();
					runChunk = chunk;
					run += segment;
				}
				cursor.position++;
			}
			flush();
			return out;
		}
		if (child.type === "element" && !SKIP.has(child.tagName)) wrap(child, cursor, boundaries);
		return [child];
	});
}

export function rehypeStreamFade(ledger?: FadeLedger) {
	return (tree: Root) => {
		try {
			const tail = tree.children.findLast((child) => child.type === "element") as Element | undefined;
			if (tail && !SKIP.has(tail.tagName) && textLength(tail) <= MAX_BLOCK_CHARS) {
				const boundaries = ledger ? record(ledger, tail, graphemeCount(tail)) : undefined;
				wrap(tail, { position: 0, chunk: 0 }, boundaries);
			}
		} catch {
			// Leave the reply readable rather than fail the render.
		}
	};
}
