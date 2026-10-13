import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { createElement } from "react";
import { createFadeLedger, rehypeStreamFade, type FadeLedger } from "./rehype-stream-fade";

const html = (text: string) =>
	renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [rehypeStreamFade] }, text));
const spans = (out: string) => out.match(/class="stream-char"/g)?.length ?? 0;

describe("rehypeStreamFade", () => {
	it("wraps prose characters, including inside emphasis", () => {
		const out = html("a **b**");
		expect(spans(out)).toBe(3);
		expect(out).toContain("<strong><span");
	});

	it("wraps only the last block", () => {
		const out = html("first\n\nsecond");
		expect(out).toContain("<p>first</p>");
		expect(spans(out)).toBe(6);
	});

	it("leaves code untouched", () => {
		expect(html("`x` and")).toContain("<code>x</code>");
		expect(html("```\nfoo\n```")).not.toContain("stream-char");
		expect(html("text\n\n```\nfoo\n```")).not.toContain("stream-char");
	});

	it("keeps table whitespace structural", () => {
		const out = html("|a|\n|-|\n|b|");
		expect(out).not.toMatch(/<tr>\s*<span/);
		expect(spans(out)).toBeGreaterThan(0);
	});

	it("keeps a grapheme cluster in one span and emoji as plain text", () => {
		expect(spans(html("é"))).toBe(1);
		const out = html("a👨‍👩‍👧b");
		expect(spans(out)).toBe(2);
		expect(out).toContain("👨‍👩‍👧");
		expect(out).not.toMatch(/stream-char">👨/);
	});

	it("leaves a block over the size cap plain", () => {
		expect(spans(html("x".repeat(4000)))).toBe(4000);
		expect(spans(html("x".repeat(4001)))).toBe(0);
	});

	it("never throws on a tree it does not expect", () => {
		const transform = rehypeStreamFade();
		expect(() => transform({ type: "root", children: [] })).not.toThrow();
		expect(() => transform({ type: "root" } as never)).not.toThrow();
		expect(() => transform(undefined as never)).not.toThrow();
		expect(html("")).toBe("");
	});
});

// One streaming message renders again and again with more text, keeping its ledger.
const stream = (ledger: FadeLedger, text: string) =>
	renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [[rehypeStreamFade, ledger]] }, text));
const spanTexts = (out: string) => Array.from(out.matchAll(/<span class="stream-char">([^<]*)<\/span>/g), (match) => match[1]);

describe("rehypeStreamFade with a ledger", () => {
	it("wraps what arrived together in one span, and keeps earlier spans as they were", () => {
		const ledger = createFadeLedger();
		expect(spanTexts(stream(ledger, "Hel"))).toEqual(["Hel"]);
		expect(spanTexts(stream(ledger, "Hello wo"))).toEqual(["Hel", "lo wo"]);
		expect(spanTexts(stream(ledger, "Hello world"))).toEqual(["Hel", "lo wo", "rld"]);
	});

	it("is idempotent: rendering the same text again adds no span", () => {
		const ledger = createFadeLedger();
		stream(ledger, "one");
		stream(ledger, "one two");
		expect(spanTexts(stream(ledger, "one two"))).toEqual(["one", " two"]);
		expect(spanTexts(stream(ledger, "one two"))).toEqual(["one", " two"]);
	});

	it("starts over when a new block begins, as only the last block is wrapped", () => {
		const ledger = createFadeLedger();
		stream(ledger, "first");
		stream(ledger, "first part");
		const out = stream(ledger, "first part\n\nnext");
		expect(out).toContain("<p>first part</p>");
		expect(spanTexts(out)).toEqual(["next"]);
	});

	it("splits a chunk around emoji, which stay plain text", () => {
		const ledger = createFadeLedger();
		stream(ledger, "ab");
		const out = stream(ledger, "ab c👨‍👩‍👧d e");
		expect(spanTexts(out)).toEqual(["ab", " c", "d e"]);
		expect(out).toContain("👨‍👩‍👧");
	});

	it("follows the text through emphasis that arrives later", () => {
		const ledger = createFadeLedger();
		stream(ledger, "a b");
		const out = stream(ledger, "a **bold** c");
		expect(spanTexts(out).join("")).toBe("a bold c");
		expect(out).toContain("<strong><span");
	});

	it("copes with the text getting shorter", () => {
		const ledger = createFadeLedger();
		stream(ledger, "abcdef");
		stream(ledger, "abcdefghij");
		expect(spanTexts(stream(ledger, "abc")).join("")).toBe("abc");
		expect(spanTexts(stream(ledger, "abcxyz")).join("")).toBe("abcxyz");
	});

	it("uses far fewer elements than a span per character for a long stream", () => {
		const ledger = createFadeLedger();
		let text = "";
		for (let index = 0; index < 50; index += 1) {
			text += "word ".repeat(2);
			stream(ledger, text);
		}
		const out = stream(ledger, text);
		// Markdown trims the trailing space, so the visible text is one character shorter.
		expect(spanTexts(out).join("")).toBe(text.trimEnd());
		expect(spans(out)).toBe(50);
		expect(spans(html(text))).toBe(text.trimEnd().length);
	});
});
