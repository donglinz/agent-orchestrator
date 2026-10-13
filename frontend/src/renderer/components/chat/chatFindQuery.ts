/**
 * The one definition of what a find query means, shared by the data search
 * (`chatFindSearch.ts`) and the highlight painter (`chatFindHighlight.ts`) so the
 * match count and the painted ranges can never disagree about the needle.
 */

/**
 * The needle a query searches for: case-folded, with leading and trailing
 * whitespace ignored and inner whitespace runs collapsed to one space. A space
 * typed while composing the next word must not make matches vanish, and an
 * all-whitespace query is empty.
 */
export function normalizeFindQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The query is only searched once it has something visible in it. */
export function isSearchableQuery(query: string): boolean {
	return normalizeFindQuery(query).length > 0;
}

/**
 * A matcher for rendered text, where whitespace has not been collapsed: any run of
 * whitespace (including a line break) between the needle's words matches, exactly
 * as the data search sees collapsed text.
 */
export function findNeedlePattern(query: string): RegExp | undefined {
	const needle = normalizeFindQuery(query);
	if (!needle) return undefined;
	const source = needle
		.split(" ")
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	return new RegExp(source, "giu");
}
