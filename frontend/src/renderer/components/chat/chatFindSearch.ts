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

import type { ConversationItem } from "../../types/conversation";
import { fileChangeFiles, isCompaction, isSteer } from "../../types/conversation";
import { humanVisibleText, stagedAttachmentParts } from "./messageAttachments";

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

/** The query is only searched once it has something visible in it. */
export function isSearchableQuery(query: string): boolean {
	return query.trim().length > 0;
}

/**
 * Plain text for what a rendered markdown message shows: link targets, emphasis
 * markers, fences and list bullets are syntax, not something the reader can see or
 * would search for.
 */
export function markdownVisibleText(markdown: string): string {
	return markdown
		.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/\*\*|~~|`/g, "");
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

/**
 * The needle a query searches for: lowercased, inner whitespace collapsed, ends
 * trimmed. A space typed while composing the next word must not change the match.
 */
export function normalizeFindQuery(query: string): string {
	return collapseWhitespace(query.trim()).toLowerCase();
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
