import {
	createContext,
	isValidElement,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
	type RefObject,
} from "react";

/**
 * Windowing inside one turn.
 *
 * The timeline virtualizes whole turns, which does nothing for a single turn that
 * has run for hours and holds hundreds of rows. A `WindowedRow` keeps its rows
 * mounted near the viewport and swaps the ones far away for an empty box of the
 * exact height they had, so the scroll height, the scrollbar and every row's
 * position are unchanged and only the DOM shrinks.
 *
 * Rows mount in full first and are measured by the browser, never estimated, so
 * there is no layout guess to correct while the reader scrolls.
 */

/** The element the transcript scrolls in; rows observe their visibility against it. */
export const ChatScrollRootContext = createContext<RefObject<HTMLElement | null> | null>(null);

/** How far beyond the viewport a row stays mounted, as a share of the viewport height. */
const OVERSCAN = "150% 0px";
/** Resizing the transcript reflows text, so measured heights are stale until rows are measured again. */
const RESIZE_SETTLE_MS = 200;

interface RowListener {
	entry: (entry: IntersectionObserverEntry) => void;
	reset: () => void;
}

interface RootObserver {
	io: IntersectionObserver;
	ro: ResizeObserver | undefined;
	rows: Map<Element, RowListener>;
}

const rootObservers = new WeakMap<Element, RootObserver>();

function observerFor(root: HTMLElement): RootObserver {
	const existing = rootObservers.get(root);
	if (existing) return existing;
	const rows = new Map<Element, RowListener>();
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) rows.get(entry.target)?.entry(entry);
		},
		{ root, rootMargin: OVERSCAN },
	);
	let ro: ResizeObserver | undefined;
	if (typeof ResizeObserver !== "undefined") {
		let width = root.clientWidth;
		let timer: number | undefined;
		ro = new ResizeObserver(() => {
			if (root.clientWidth === width) return;
			width = root.clientWidth;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				// Mount everything again and observe it fresh: the next callback re-measures
				// each row at the new width and collapses the ones that are off screen.
				for (const [element, listener] of rows) {
					listener.reset();
					io.unobserve(element);
					io.observe(element);
				}
			}, RESIZE_SETTLE_MS);
		});
		ro.observe(root);
	}
	const observer = { io, ro, rows };
	rootObservers.set(root, observer);
	return observer;
}

function observeRow(root: HTMLElement, element: Element, listener: RowListener): () => void {
	const observer = observerFor(root);
	observer.rows.set(element, listener);
	observer.io.observe(element);
	return () => {
		observer.rows.delete(element);
		observer.io.unobserve(element);
		if (observer.rows.size === 0) {
			observer.io.disconnect();
			observer.ro?.disconnect();
			rootObservers.delete(root);
		}
	};
}

/**
 * A row holding something the reader set up must stay mounted, or the unmount drops it:
 * focus, a text selection, or an open disclosure. Most disclosures (an expanded command,
 * diff, tool call or nested run) keep their open state in the row itself, so the row is
 * the only place it lives; `aria-expanded` is how every one of them says it is open.
 */
function holdsReaderState(element: HTMLElement): boolean {
	if (element.contains(document.activeElement)) return true;
	if (element.querySelector('[aria-expanded="true"]')) return true;
	const selection = window.getSelection();
	return Boolean(selection && !selection.isCollapsed && selection.anchorNode && element.contains(selection.anchorNode));
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * `children` is a fresh element on every render of the turn, but the row inside it
 * is already memoized on its own props. Compare those props instead, so a refresh
 * that did not change this row does not render it, or its wrapper, at all.
 */
function sameRow(
	previous: { itemIds: string; pinned: boolean; children: ReactNode },
	next: { itemIds: string; pinned: boolean; children: ReactNode },
): boolean {
	if (previous.itemIds !== next.itemIds || previous.pinned !== next.pinned) return false;
	const a = previous.children;
	const b = next.children;
	if (!isValidElement(a) || !isValidElement(b)) return a === b;
	return (
		(a as ReactElement).type === (b as ReactElement).type &&
		shallowEqual((a as ReactElement<Record<string, unknown>>).props, (b as ReactElement<Record<string, unknown>>).props)
	);
}

export const WindowedRow = memo(function WindowedRow({
	itemIds,
	pinned,
	children,
}: {
	/** Space-separated ids of the conversation items drawn inside, so a jump to one can find its box. */
	itemIds: string;
	/** Keep the row mounted regardless of where it is, for example while its message is being edited. */
	pinned: boolean;
	children: ReactNode;
}) {
	const root = useContext(ChatScrollRootContext);
	const element = useRef<HTMLDivElement>(null);
	const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null);
	const pinnedRef = useRef(pinned);
	pinnedRef.current = pinned;

	useEffect(() => {
		const node = element.current;
		const scroller = root?.current;
		if (!node || !scroller || typeof IntersectionObserver === "undefined") return;
		return observeRow(scroller, node, {
			entry: (entry) => {
				if (entry.isIntersecting || pinnedRef.current || holdsReaderState(node)) {
					setCollapsedHeight(null);
					return;
				}
				// The box was measured by the browser a moment ago, so it is the exact height.
				const height = entry.boundingClientRect.height;
				if (height > 0) setCollapsedHeight(height);
			},
			reset: () => setCollapsedHeight(null),
		});
	}, [root]);
	useEffect(() => {
		if (pinned) setCollapsedHeight(null);
	}, [pinned]);

	const collapsed = collapsedHeight !== null;
	return (
		<div
			ref={element}
			data-chat-window-items={itemIds}
			// A row that draws nothing must not leave a gap behind either.
			className={collapsed ? "flex min-w-0 flex-col" : "flex min-w-0 flex-col empty:hidden"}
			style={collapsed ? { height: collapsedHeight } : undefined}
		>
			{collapsed ? null : children}
		</div>
	);
}, sameRow);
