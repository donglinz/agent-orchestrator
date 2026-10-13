/**
 * Lets in-chat find open whatever disclosure hides a match.
 *
 * A match can sit inside a settled turn's folded "Worked for" section, inside a
 * collapsed run of tool calls, or inside a collapsed group within that run. Each of
 * those owns its own open state, so navigation does not reach in and flip them; it
 * announces "reveal this item" and every disclosure that contains it opens itself.
 *
 * The announcement is an external store rather than props or context value
 * changes: a subscriber is only re-rendered when it contains the revealed item, so
 * stepping through matches never re-renders the rest of a long timeline.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

export interface ChatFindRevealStore {
	/** Ask every disclosure containing `itemId` to open. Each call is a fresh request. */
	reveal(itemId: string): void;
	/** Drop the pending request so a disclosure mounted later does not reopen. */
	clear(): void;
	subscribe(listener: () => void): () => void;
	/** The pending request, or undefined. */
	current(): { itemId: string; nonce: number } | undefined;
}

export function createChatFindRevealStore(): ChatFindRevealStore {
	let request: { itemId: string; nonce: number } | undefined;
	let nonce = 0;
	const listeners = new Set<() => void>();
	return {
		reveal(itemId) {
			nonce += 1;
			request = { itemId, nonce };
			for (const listener of [...listeners]) listener();
		},
		clear() {
			if (!request) return;
			request = undefined;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		current: () => request,
	};
}

export const ChatFindRevealContext = createContext<ChatFindRevealStore | null>(null);

/**
 * Calls `open` whenever find reveals an item that `contains` says is inside this
 * disclosure. A no-op outside a timeline that provides a store.
 */
export function useChatFindReveal(contains: (itemId: string) => boolean, open: () => void): void {
	const store = useContext(ChatFindRevealContext);
	const nonce = useSyncExternalStore(
		store ? store.subscribe : noopSubscribe,
		() => {
			const request = store?.current();
			return request && contains(request.itemId) ? request.nonce : 0;
		},
		() => 0,
	);
	useEffect(() => {
		if (nonce > 0) open();
		// `open` is rebuilt every render by design; only a new request should fire it.
	}, [nonce]);
}

function noopSubscribe(): () => void {
	return () => undefined;
}
