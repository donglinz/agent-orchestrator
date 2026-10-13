/**
 * In-chat find: match computation and keyboard intent.
 *
 * The timeline is virtualized, so the browser's own find cannot see off-screen
 * turns. Matching therefore runs over the conversation data, in the text a reader
 * actually sees, and the DOM is only consulted afterwards to paint highlights on
 * whatever happens to be mounted (see `chatFindHighlight.ts`).
 *
 * Results are kept compact: one hit per matching item plus a running offset, so a
 * one-letter query over a very long chat is an array of items rather than an array
 * of every occurrence.
 */

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ConversationItem } from "../../types/conversation";
import { fileChangeFiles, isCompaction, isSteer } from "../../types/conversation";
import { isSearchableQuery, normalizeFindQuery } from "./chatFindQuery";
import { humanVisibleText, stagedAttachmentParts } from "./messageAttachments";

export { isSearchableQuery, normalizeFindQuery };

/** A turn-sized block of items, as the timeline groups them. */
export interface ChatFindGroup {
	key: string;
	items: readonly ConversationItem[];
}

/** One item that contains the query, and where its matches sit in the global order. */
export interface ChatFindHit {
	itemId: string;
	groupKey: string;
	/** How many times the query occurs in this item's searchable text. */
	count: number;
	/** Index of this item's first match among all matches. */
	start: number;
}

export interface ChatFindResult {
	query: string;
	hits: ChatFindHit[];
	total: number;
}

export const EMPTY_FIND_RESULT: ChatFindResult = { query: "", hits: [], total: 0 };

/** The slice of an mdast node this extractor reads. */
interface MarkdownNode {
	type: string;
	value?: string;
	alt?: string | null;
	children?: MarkdownNode[];
}

// Parsed like the transcript renders it (`ChatMarkdown` uses react-markdown with
// remark-gfm), so tables, strikethrough and autolinks mean the same thing here.
const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** Blocks that start on their own line; cells inside a row are spaced instead. */
const BLOCK_NODES = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "table", "tableRow", "footnoteDefinition"]);

/** Inline (phrasing) parents: an `html` node inside one is a tag fragment, not a block. */
const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference"]);

function collectVisibleText(node: MarkdownNode, out: string[], parent?: MarkdownNode): void {
	switch (node.type) {
		// Literal text: code keeps every character, markdown syntax included.
		case "text":
		case "inlineCode":
			out.push(node.value ?? "");
			return;
		// Raw HTML is literal too. At block level it stands alone like a fence.
		case "html":
			if (parent && PHRASING_PARENTS.has(parent.type)) out.push(node.value ?? "");
			else out.push("\n", node.value ?? "", "\n");
			return;
		// A fenced or indented block is literal too, but it is a block: remark strips
		// the newline around its value, so it needs its own separators or two
		// adjacent blocks would read as one word.
		case "code":
			out.push("\n", node.value ?? "", "\n");
			return;
		case "image":
		case "imageReference":
			out.push(node.alt ?? "");
			return;
		case "break":
			out.push("\n");
			return;
		// Not drawn, but still a block boundary: text on either side stays apart.
		case "definition":
		case "thematicBreak":
		case "yaml":
			out.push("\n");
			return;
	}
	const blockBreak = BLOCK_NODES.has(node.type);
	if (blockBreak) out.push("\n");
	node.children?.forEach((child, index) => {
		if (node.type === "tableRow" && index > 0) out.push(" ");
		collectVisibleText(child, out, node);
	});
	if (blockBreak) out.push("\n");
}

/**
 * Plain text for what a rendered markdown message shows. The message is parsed, so
 * only real markup is dropped: link targets, emphasis markers, fence lines, heading
 * hashes and list bullets are syntax, while the contents of code spans and fenced
 * blocks stay literal (`2 ** 3` in code is searched as `2 ** 3`).
 */
export function markdownVisibleText(markdown: string): string {
	try {
		const out: string[] = [];
		collectVisibleText(markdownParser.parse(markdown) as MarkdownNode, out);
		return out.join("");
	} catch {
		// A parse failure must not hide the message from search.
		return markdown;
	}
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ");
}

/**
 * The text of an item a reader can see in the transcript, or "" when the item has
 * none worth searching. Hidden payloads (the `<ao-worker-reports>` envelope on a
 * human message, command output, rows the timeline draws nothing for) are
 * deliberately excluded.
 */
export function findableText(item: ConversationItem): string {
	if (item.kind === "message") {
		if (item.role === "assistant") return markdownVisibleText(item.text);
		if (item.origin === "human") return stagedAttachmentParts(humanVisibleText(item.text)).body;
		return markdownVisibleText(item.text);
	}
	// Mirrors the activities `TimelineItem` renders nothing for.
	if (item.activityKind === "usage" || item.activityKind === "reasoning" || item.activityKind === "user_input") return "";
	if (item.activityKind === "approval" && item.status === "pending") return "";
	if (isCompaction(item)) return "";
	if (isSteer(item)) return stagedAttachmentParts(humanVisibleText(item.detail?.text ?? item.summary)).body;
	if (item.activityKind === "plan") return "";
	const detail = item.detail;
	// A command row shows a derived label ("Ran command") until it is opened; its
	// own words are the command and the reason the agent gave. Find opens the row.
	if (item.activityKind === "command") {
		return [detail?.command ?? item.summary, detail?.reason ?? detail?.text].filter(Boolean).join("\n");
	}
	if (item.activityKind === "file_change") {
		return [item.summary, ...fileChangeFiles(item).map((file) => file.path)].join("\n");
	}
	return item.summary;
}

// Searchable text is lowercased and whitespace-collapsed once per item object. A
// snapshot refresh keeps untouched items by reference, so a long history is not
// re-normalized on every poll or keystroke.
const normalizedCache = new WeakMap<ConversationItem, string>();

function normalizedText(item: ConversationItem): string {
	let cached = normalizedCache.get(item);
	if (cached === undefined) {
		cached = collapseWhitespace(findableText(item)).toLowerCase();
		normalizedCache.set(item, cached);
	}
	return cached;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = haystack.indexOf(needle);
	while (from !== -1) {
		count += 1;
		from = haystack.indexOf(needle, from + needle.length);
	}
	return count;
}

/** Case-insensitive search over the visible text of every item, in timeline order. */
export function searchChatItems(groups: readonly ChatFindGroup[], query: string): ChatFindResult {
	if (!isSearchableQuery(query)) return EMPTY_FIND_RESULT;
	const needle = normalizeFindQuery(query);
	const hits: ChatFindHit[] = [];
	let total = 0;
	for (const group of groups) {
		for (const item of group.items) {
			const text = normalizedText(item);
			if (text.length < needle.length) continue;
			const count = countOccurrences(text, needle);
			if (count === 0) continue;
			hits.push({ itemId: item.id, groupKey: group.key, count, start: total });
			total += count;
		}
	}
	return { query, hits, total };
}

export interface ChatFindLocation {
	hit: ChatFindHit;
	/** Which occurrence inside the item, zero-based. */
	ordinal: number;
}

/** Maps a global match index to its item and the occurrence inside that item. */
export function locateMatch(result: ChatFindResult, index: number): ChatFindLocation | undefined {
	if (index < 0 || index >= result.total) return undefined;
	let low = 0;
	let high = result.hits.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (result.hits[mid]!.start <= index) low = mid;
		else high = mid - 1;
	}
	const hit = result.hits[low];
	return hit ? { hit, ordinal: index - hit.start } : undefined;
}

/** The global index of a known item occurrence, if it still matches. */
export function indexOfMatch(result: ChatFindResult, itemId: string, ordinal: number): number | undefined {
	const hit = result.hits.find((candidate) => candidate.itemId === itemId);
	if (!hit) return undefined;
	return hit.start + Math.min(ordinal, hit.count - 1);
}

/** Next or previous match, wrapping at either end. */
export function stepMatch(index: number, total: number, direction: 1 | -1): number {
	if (total <= 0) return -1;
	return (((index + direction) % total) + total) % total;
}

/**
 * The first match at or after `groupIndex` in the timeline, so opening find near
 * the bottom of a long chat starts there rather than at the oldest message. Wraps
 * to the first match when nothing lies at or after it.
 */
export function firstMatchFromGroup(
	result: ChatFindResult,
	groups: readonly ChatFindGroup[],
	groupIndex: number,
): number {
	if (result.total === 0) return -1;
	const order = new Map(groups.map((group, index) => [group.key, index]));
	for (const hit of result.hits) {
		if ((order.get(hit.groupKey) ?? -1) >= groupIndex) return hit.start;
	}
	return 0;
}

export type FindShortcut = "open" | "next" | "previous";

/**
 * The find command a key event asks for: Cmd/Ctrl+F opens, Cmd/Ctrl+G steps, and
 * Shift reverses the step. Alt-modified and cross-platform modifier combinations
 * (Ctrl+F on macOS is "forward char", Cmd+F on Windows is not a shortcut) are not
 * ours.
 */
export function findShortcutOf(
	event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
	isMac: boolean,
): FindShortcut | undefined {
	if (event.altKey) return undefined;
	if (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return undefined;
	const key = event.key.toLowerCase();
	// `code` keeps the shortcut working on non-Latin layouts, where `key` is the
	// layout's own letter.
	if (key === "f" || event.code === "KeyF") return event.shiftKey ? undefined : "open";
	if (key === "g" || event.code === "KeyG") return event.shiftKey ? "previous" : "next";
	return undefined;
}
