import { describe, expect, it } from "vitest";
import { findNeedlePattern, isSearchableQuery, normalizeFindQuery } from "./chatFindQuery";

describe("normalizeFindQuery", () => {
	it("folds case, ignores the ends and collapses inner whitespace", () => {
		expect(normalizeFindQuery("Foo")).toBe("foo");
		expect(normalizeFindQuery("foo ")).toBe("foo");
		expect(normalizeFindQuery("  foo\t")).toBe("foo");
		expect(normalizeFindQuery("foo  \n bar ")).toBe("foo bar");
	});

	it("treats an all-whitespace query as empty", () => {
		expect(normalizeFindQuery(" \t\n")).toBe("");
		expect(isSearchableQuery("   ")).toBe(false);
		expect(isSearchableQuery(" a ")).toBe(true);
		expect(findNeedlePattern("   ")).toBeUndefined();
	});
});

describe("findNeedlePattern", () => {
	it("matches any whitespace run between words and escapes the rest", () => {
		const pattern = findNeedlePattern("a.b  (c)");
		expect(pattern?.test("A.B \n (C)")).toBe(true);
		pattern!.lastIndex = 0;
		expect(pattern?.test("axb (c)")).toBe(false);
	});
});
