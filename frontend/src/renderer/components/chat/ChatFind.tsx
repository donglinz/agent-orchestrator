/**
 * Cmd/Ctrl+F find for a chat timeline.
 *
 * Owns its own state (open, query, current match) so typing re-renders only this
 * component, never the timeline. It talks to the timeline through three small
 * seams: the scroll container and content element, `scrollToGroup` to bring a turn
 * into the virtualized window, and the reveal store that opens collapsed
 * disclosures around a match.
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type RefObject,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isMacPlatform } from "../../lib/platform";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
	type ChatFindGroup,
	type ChatFindLocation,
	findShortcutOf,
	firstMatchFromGroup,
	indexOfMatch,
	isSearchableQuery,
	locateMatch,
	searchChatItems,
	stepMatch,
} from "./chatFindSearch";
import {
	activeRangeIn,
	clearFindHighlights,
	findItemElement,
	paintFindHighlights,
	rectOf,
	scrollRectIntoView,
} from "./chatFindHighlight";
import type { ChatFindRevealStore } from "./chatFindReveal";

/** Keystrokes settle this long before the data search runs. */
export const FIND_DEBOUNCE_MS = 120;
/** Repaint trailing edge while rows mount, unmount, or stream. */
const REPAINT_DELAY_MS = 100;
const REVEAL_RETRY_MS = 50;
const REVEAL_MAX_ATTEMPTS = 30;
/** Rows animate open and re-measure; look once more after they settle. */
const SETTLE_DELAY_MS = 280;
/** A panel that owns its own find (the terminal's) keeps Cmd/Ctrl+F. */
const OWN_FIND_SELECTOR = ".xterm, [data-find-owner]";

const isMac = isMacPlatform();

export interface ChatFindProps {
	/** The timeline's root element; the find scope is its conversation panel. */
	rootRef: RefObject<HTMLElement | null>;
	scrollerRef: RefObject<HTMLElement | null>;
	/** Wraps every rendered turn; highlights are painted inside it. */
	contentRef: RefObject<HTMLElement | null>;
	groups: readonly ChatFindGroup[];
	/** Older history is not loaded, so the match count is a lower bound. */
	hasOlder?: boolean;
	revealStore: ChatFindRevealStore;
	/** Bring a turn into the mounted window and stop following the live edge. */
	scrollToGroup: (groupKey: string) => void;
	/** Index of the first turn at or below the top of the viewport. */
	viewportGroupIndex: () => number | undefined;
}

function isDocumentTarget(target: EventTarget | null): boolean {
	return target === document.body || target === document.documentElement || target === document;
}

export function ChatFind({
	rootRef,
	scrollerRef,
	contentRef,
	groups,
	hasOlder,
	revealStore,
	scrollToGroup,
	viewportGroupIndex,
}: ChatFindProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [focusRequest, setFocusRequest] = useState(0);
	const [value, setValue] = useState("");
	const [query, setQuery] = useState("");
	const [current, setCurrent] = useState<{ itemId: string; ordinal: number } | null>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const navigationToken = useRef(0);
	const navigationTimer = useRef<number | undefined>(undefined);
	const pointerInsideRef = useRef(false);

	// Matching reads the data on a deferred copy so a streaming turn never makes
	// typing wait for a re-scan.
	const deferredGroups = useDeferredValue(groups);
	const result = useMemo(
		() => (open ? searchChatItems(deferredGroups, query) : searchChatItems([], "")),
		[deferredGroups, open, query],
	);
	const activeIndex = current ? indexOfMatch(result, current.itemId, current.ordinal) ?? -1 : -1;

	// The latest values for handlers that outlive a render (document listeners, timers).
	const latest = useRef({ open, result, activeIndex, groups, current, query });
	latest.current = { open, result, activeIndex, groups, current, query };

	const cancelNavigation = useCallback(() => {
		navigationToken.current += 1;
		window.clearTimeout(navigationTimer.current);
		navigationTimer.current = undefined;
		// A navigation that never reached its settle pass must not leave a request
		// that would reopen a disclosure mounted later.
		revealStore.clear();
	}, [revealStore]);

	const navigate = useCallback(
		(location: ChatFindLocation, searchQuery: string) => {
			cancelNavigation();
			const token = navigationToken.current;
			const { itemId, groupKey } = location.hit;
			const { ordinal } = location;
			scrollToGroup(groupKey);
			revealStore.reveal(itemId);
			let attempts = 0;
			const place = (element: HTMLElement) => {
				const scroller = scrollerRef.current;
				if (!scroller) return;
				const range = activeRangeIn(element, searchQuery, ordinal);
				const rect = rectOf(range ?? element);
				if (rect) scrollRectIntoView(scroller, rect);
			};
			const attempt = () => {
				if (token !== navigationToken.current) return;
				const content = contentRef.current;
				if (!content) return;
				const element = findItemElement(content, itemId);
				if (!element) {
					attempts += 1;
					if (attempts > REVEAL_MAX_ATTEMPTS) {
						revealStore.clear();
						return;
					}
					// Row heights keep settling while the virtualizer measures; aim again.
					if (attempts % 5 === 0) scrollToGroup(groupKey);
					navigationTimer.current = window.setTimeout(attempt, REVEAL_RETRY_MS);
					return;
				}
				place(element);
				// The request stays pending past this render: a row that is already
				// mounted (a visible command, say) opens itself from it, and the settle
				// pass re-aims once the disclosure has grown.
				navigationTimer.current = window.setTimeout(() => {
					if (token !== navigationToken.current) return;
					const settled = contentRef.current && findItemElement(contentRef.current, itemId);
					if (settled) place(settled);
					revealStore.clear();
				}, SETTLE_DELAY_MS);
			};
			attempt();
		},
		[cancelNavigation, contentRef, revealStore, scrollToGroup, scrollerRef],
	);

	const goTo = useCallback(
		(index: number) => {
			const { result: latestResult } = latest.current;
			const location = locateMatch(latestResult, index);
			if (!location) return;
			setCurrent({ itemId: location.hit.itemId, ordinal: location.ordinal });
			navigate(location, latestResult.query);
		},
		[navigate],
	);

	const step = useCallback(
		(direction: 1 | -1) => {
			const { result: latestResult, activeIndex: index } = latest.current;
			if (latestResult.total === 0) return;
			// Until the first match is chosen the bar shows "1 of N", so step from there.
			goTo(stepMatch(Math.max(index, 0), latestResult.total, direction));
		},
		[goTo],
	);

	const openFind = useCallback(() => {
		if (!latest.current.open) {
			const active = document.activeElement;
			const scope = rootRef.current?.closest("[data-chat-find-scope]") ?? rootRef.current;
			returnFocusRef.current =
				active instanceof HTMLElement && active !== document.body && scope?.contains(active) ? active : null;
			setOpen(true);
		}
		setFocusRequest((request) => request + 1);
	}, [rootRef]);

	const closeFind = useCallback(() => {
		cancelNavigation();
		revealStore.clear();
		setOpen(false);
		setValue("");
		setQuery("");
		setCurrent(null);
		const target = returnFocusRef.current;
		returnFocusRef.current = null;
		if (target?.isConnected) target.focus({ preventScroll: true });
	}, [cancelNavigation, revealStore]);

	// Focus and select the field on open and whenever Cmd/Ctrl+F is pressed again.
	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open, focusRequest]);

	// Debounce typing into the searched query; clearing is immediate.
	useEffect(() => {
		if (!open || value === query) return;
		if (!value) {
			setQuery("");
			return;
		}
		const timer = window.setTimeout(() => setQuery(value), FIND_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [open, query, value]);

	// A new query jumps to its first match at or below where the reader is.
	useEffect(() => {
		if (!open) return;
		if (!isSearchableQuery(query)) {
			cancelNavigation();
			setCurrent(null);
			return;
		}
		const { result: latestResult, groups: latestGroups } = latest.current;
		if (latestResult.total === 0) {
			cancelNavigation();
			setCurrent(null);
			return;
		}
		goTo(firstMatchFromGroup(latestResult, latestGroups, viewportGroupIndex() ?? 0));
		// A new query repositions, and so does the first match arriving for a query
		// that had none (older history loading in). Further streaming must not move
		// the reader.
	}, [open, query, result.total > 0]);

	// Paint highlights over whatever is mounted, and keep them current as rows
	// mount, unmount, expand, or stream.
	useEffect(() => {
		const content = contentRef.current;
		if (!open || !content || !isSearchableQuery(query)) return;
		let timer: number | undefined;
		const paint = () => {
			timer = undefined;
			paintFindHighlights(content, query, latest.current.current ?? undefined);
		};
		paint();
		const observer = new MutationObserver(() => {
			if (timer === undefined) timer = window.setTimeout(paint, REPAINT_DELAY_MS);
		});
		observer.observe(content, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			window.clearTimeout(timer);
			clearFindHighlights();
		};
	}, [contentRef, current, open, query]);

	useEffect(() => cancelNavigation, [cancelNavigation]);

	// Cmd/Ctrl+F opens find when focus is in this chat, or on the page body right
	// after a click inside it (clicking message text leaves nothing focused).
	// Anywhere else (a terminal, the browser panel, another panel's field) keeps its
	// own behavior.
	useEffect(() => {
		const scopeOf = () => rootRef.current?.closest<HTMLElement>("[data-chat-find-scope]") ?? rootRef.current;
		const onPointerDown = (event: PointerEvent) => {
			const scope = scopeOf();
			pointerInsideRef.current = Boolean(scope && event.target instanceof Node && scope.contains(event.target));
		};
		const onFocusIn = (event: FocusEvent) => {
			const scope = scopeOf();
			if (scope && event.target instanceof Node && !scope.contains(event.target)) pointerInsideRef.current = false;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const shortcut = findShortcutOf(event, isMac);
			if (!shortcut) return;
			if (shortcut !== "open" && !latest.current.open) return;
			const scope = scopeOf();
			if (!scope || !scope.isConnected || scope.closest("[hidden], [inert], [aria-hidden='true']")) return;
			const target = event.target instanceof Node ? event.target : null;
			// The bar handles its own keys.
			if (target && barRef.current?.contains(target)) return;
			if (target && scope.contains(target)) {
				if (target instanceof Element && target.closest(OWN_FIND_SELECTOR)) return;
			} else if (!(isDocumentTarget(event.target) && pointerInsideRef.current)) {
				return;
			}
			event.preventDefault();
			if (shortcut === "open") openFind();
			else step(shortcut === "next" ? 1 : -1);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openFind, rootRef, step]);

	const onBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		// Nothing typed here may reach the composer or an app-level shortcut.
		event.stopPropagation();
		if (event.nativeEvent.isComposing) return;
		const shortcut = findShortcutOf(event.nativeEvent, isMac);
		if (event.key === "Escape") {
			event.preventDefault();
			closeFind();
		} else if (event.key === "Enter") {
			event.preventDefault();
			// A pending debounce is flushed first; the new query lands on its first match.
			if (value !== query) setQuery(value);
			else step(event.shiftKey ? -1 : 1);
		} else if (shortcut === "open") {
			event.preventDefault();
			inputRef.current?.select();
		} else if (shortcut) {
			event.preventDefault();
			step(shortcut === "next" ? 1 : -1);
		}
	};

	if (!open) return null;

	const searched = isSearchableQuery(query);
	const partial = Boolean(hasOlder);
	let count = "";
	if (searched) {
		count = result.total === 0
			? t("chat.find.noResults")
			: t(partial ? "chat.find.countPartial" : "chat.find.count", {
					current: Math.max(activeIndex, 0) + 1,
					total: result.total,
				});
	}
	const keepInputFocus = (event: { preventDefault: () => void }) => event.preventDefault();

	return (
		<div
			ref={barRef}
			role="search"
			aria-label={t("chat.find.label")}
			data-testid="chat-find-bar"
			className="absolute right-8 top-2 z-20 flex h-9 w-80 max-w-[calc(100%-3rem)] items-center gap-0.5 rounded-lg border border-border bg-popover px-1 text-popover-foreground shadow-lg focus-within:border-ring"
			onKeyDown={onBarKeyDown}
		>
			<Input
				ref={inputRef}
				aria-label={t("chat.find.label")}
				className="h-7 flex-1 bg-transparent px-2"
				maxLength={512}
				onChange={(event) => setValue(event.target.value)}
				placeholder={t("chat.find.placeholder")}
				type="text"
				value={value}
			/>
			<span
				aria-live="polite"
				className={cn(
					"min-w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground",
					searched && result.total === 0 && "text-destructive",
				)}
				data-testid="chat-find-count"
				title={searched && partial ? t("chat.find.partialHint") : undefined}
			>
				{count}
			</span>
			<Button
				aria-label={t("chat.find.previous")}
				className="text-muted-foreground"
				disabled={result.total === 0}
				onClick={() => step(-1)}
				onMouseDown={keepInputFocus}
				size="icon-sm"
				type="button"
				variant="ghost"
			>
				<ChevronUp aria-hidden="true" className="size-icon-sm" />
			</Button>
			<Button
				aria-label={t("chat.find.next")}
				className="text-muted-foreground"
				disabled={result.total === 0}
				onClick={() => step(1)}
				onMouseDown={keepInputFocus}
				size="icon-sm"
				type="button"
				variant="ghost"
			>
				<ChevronDown aria-hidden="true" className="size-icon-sm" />
			</Button>
			<Button
				aria-label={t("chat.find.close")}
				className="text-muted-foreground"
				onClick={closeFind}
				size="icon-sm"
				type="button"
				variant="ghost"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</Button>
		</div>
	);
}
