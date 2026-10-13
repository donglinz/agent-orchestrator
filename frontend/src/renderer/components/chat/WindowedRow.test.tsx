import { act, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatScrollRootContext, WindowedRow } from "./WindowedRow";

// jsdom has no IntersectionObserver. This one lets a test say what the browser would.
type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
const observers: FakeObserver[] = [];

class FakeObserver {
	targets = new Set<Element>();
	constructor(readonly callback: Callback, readonly options: IntersectionObserverInit) {
		observers.push(this);
	}
	observe = (target: Element) => void this.targets.add(target);
	unobserve = (target: Element) => void this.targets.delete(target);
	disconnect = () => this.targets.clear();
	report(target: Element, isIntersecting: boolean, height: number) {
		act(() => this.callback([{ target, isIntersecting, boundingClientRect: { height } as DOMRectReadOnly }]));
	}
}

function mountRow(props: { pinned?: boolean } = {}) {
	const root = createRef<HTMLElement>() as RefObject<HTMLElement | null>;
	const view = render(
		<div ref={root as RefObject<HTMLDivElement>}>
			<ChatScrollRootContext.Provider value={root}>
				<WindowedRow itemIds="a b" pinned={props.pinned ?? false}>
					<button type="button">row content</button>
				</WindowedRow>
			</ChatScrollRootContext.Provider>
		</div>,
	);
	const box = view.container.querySelector<HTMLElement>("[data-chat-window-items]")!;
	return { ...view, box, observer: observers.at(-1)! };
}

describe("WindowedRow", () => {
	beforeEach(() => {
		observers.length = 0;
		vi.stubGlobal("IntersectionObserver", FakeObserver);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("observes against the transcript scroller with overscan", () => {
		const { observer, box } = mountRow();
		expect(observer.targets.has(box)).toBe(true);
		expect(observer.options.root).toBeInstanceOf(HTMLElement);
		expect(observer.options.rootMargin).toBe("150% 0px");
	});

	it("swaps a far row for an empty box of its measured height, and back", () => {
		const { observer, box } = mountRow();
		expect(screen.getByText("row content")).toBeInTheDocument();

		observer.report(box, false, 123.5);
		expect(screen.queryByText("row content")).not.toBeInTheDocument();
		expect(box).toHaveStyle({ height: "123.5px" });
		// The box still names its items so a jump to one of them can find it.
		expect(box.dataset.chatWindowItems).toBe("a b");

		observer.report(box, true, 123.5);
		expect(screen.getByText("row content")).toBeInTheDocument();
		expect(box.style.height).toBe("");
	});

	it("never collapses a row that has not been measured", () => {
		const { observer, box } = mountRow();
		observer.report(box, false, 0);
		expect(screen.getByText("row content")).toBeInTheDocument();
	});

	it("keeps a pinned row mounted, and restores one that becomes pinned", () => {
		const pinned = mountRow({ pinned: true });
		pinned.observer.report(pinned.box, false, 80);
		expect(screen.getByText("row content")).toBeInTheDocument();
		pinned.unmount();

		const row = mountRow();
		row.observer.report(row.box, false, 80);
		expect(screen.queryByText("row content")).not.toBeInTheDocument();
		row.rerender(
			<div>
				<ChatScrollRootContext.Provider value={{ current: row.container }}>
					<WindowedRow itemIds="a b" pinned>
						<button type="button">row content</button>
					</WindowedRow>
				</ChatScrollRootContext.Provider>
			</div>,
		);
		expect(screen.getByText("row content")).toBeInTheDocument();
	});

	it("keeps a row that holds focus", () => {
		const { observer, box } = mountRow();
		screen.getByText("row content").focus();
		observer.report(box, false, 80);
		expect(screen.getByText("row content")).toBeInTheDocument();
	});
});
