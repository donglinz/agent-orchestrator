import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "./markdown-blocks";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
// Parsed whole, blocks are separated by "\n" text nodes; parsed apart they are not.
const normalize = (html: string) => html.replace(/>\s+</g, "><").trim();
const renderSplit = (text: string) => splitMarkdownBlocks(text).map(render).join("");

const CORPUS: Record<string, string> = {
	paragraphs: "one\n\ntwo\n\nthree\n",
	headings: "# a\n\ntext\n\n## b\n\nmore",
	tightList: "- a\n- b\n- c\n\nafter",
	looseList: "- a\n\n- b\n\n- c\n\nafter",
	listWithIndentedParagraph: "- a\n\n  still a\n\n- b\n\nafter",
	orderedAcrossBlank: "1. a\n\n2. b\n\ntext\n\n3. c",
	nestedList: "- a\n  - b\n\n    para in b\n\n- c",
	quote: "> a\n> b\n\n> c\n\ntext",
	table: "| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c |\n|---|\n| 3 |",
	fence: "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro",
	fenceHoldingMarkdown: "```md\n# not a heading\n\n- not a list\n\n[x]: not-a-definition\n<div>not html</div>\n```\n\nafter",
	tildeFence: "~~~\n\n\ntext\n~~~\n\nafter",
	longerFence: "````\n```\n\ninner\n```\n````\n\nafter",
	unclosedFence: "before\n\n```bash\nrunning\n\nstill running",
	indentedCode: "text\n\n    code\n\n    more code\n\ntext",
	setext: "Title\n=====\n\ntext\n\nSub\n---\n\nmore",
	thematicBreak: "a\n\n---\n\nb\n\n***\n\nc",
	referenceLink: "see [x]\n\ntext\n\n[x]: https://example.com",
	referenceLinkFirst: "[x]: https://example.com\n\nsee [x]",
	referenceLinkInQuote: "[foo]\n\n> [foo]: /url",
	referenceLinkInList: "[foo]\n\n- [foo]: /url\n\ntext",
	referenceLinkMultilineLabel: "[foo bar]\n\ntext\n\n[foo\nbar]: /url",
	referenceLinkEscapedBracket: "[foo]]\n\ntext\n\n[foo\\]]: /url",
	referenceLinkInFence: "[foo]\n\n```\n[foo]: /url\n```\n\ntext",
	nbspLine: "one\n\u00a0\ntwo",
	unicodeSpaceLines: "one\n\u3000\ntwo\n\u2003\nthree\n\u200b\nfour",
	formFeedAndVerticalTabLines: "one\n\f\ntwo\n\v\nthree",
	spacesAndTabsBlank: "one\n \t \ntwo\n\t\nthree",
	bareCarriageReturns: "one\r\rtwo\r\r- three",
	footnote: "a[^1]\n\ntext\n\n[^1]: note",
	html: "<details>\n<summary>s</summary>\n\nbody\n\n</details>\n\nafter",
	inlineHtml: "a <b>b</b>\n\nc",
	crlf: "a\r\n\r\nb\r\n\r\n- c\r\n- d\r\n",
	trailingBlankLines: "a\n\n\n\nb\n\n\n",
	taskList: "- [x] a\n- [ ] b\n\ntext",
	emphasisAcrossBlank: "**a\n\nb**",
	mixed: "# T\n\ntext **bold** and `code`\n\n1. a\n2. b\n\n> q\n\n```sh\nls\n```\n\n| a |\n|---|\n| b |\n\nend",
};

describe("splitMarkdownBlocks", () => {
	it.each(Object.entries(CORPUS))("%s: pieces rejoin to the input", (_, text) => {
		expect(splitMarkdownBlocks(text).join("")).toBe(text);
	});

	it.each(Object.entries(CORPUS))("%s: renders as it does in one piece", (_, text) => {
		expect(normalize(renderSplit(text))).toBe(normalize(render(text)));
	});

	it("also renders every prefix of a growing reply as it does in one piece", () => {
		for (const text of Object.values(CORPUS)) {
			for (let end = 0; end <= text.length; end += 3) {
				const prefix = text.slice(0, end);
				expect(normalize(renderSplit(prefix))).toBe(normalize(render(prefix)));
			}
		}
	});

	it("cuts between paragraphs, headings, tables and fences", () => {
		expect(splitMarkdownBlocks("one\n\ntwo\n\nthree")).toEqual(["one\n\n", "two\n\n", "three"]);
		expect(splitMarkdownBlocks("# a\n\n```\nx\n\ny\n```\n\nz")).toEqual(["# a\n\n", "```\nx\n\ny\n```\n\n", "z"]);
	});

	it("only appends: finished pieces keep their text while the reply grows", () => {
		const first = splitMarkdownBlocks("one\n\ntwo");
		const next = splitMarkdownBlocks("one\n\ntwo and more\n\nthree");
		expect(next[0]).toBe(first[0]);
		expect(next).toHaveLength(3);
	});

	it("treats only spaces and tabs as a blank line", () => {
		expect(splitMarkdownBlocks("one\n\u00a0\ntwo")).toHaveLength(1);
		expect(splitMarkdownBlocks("one\n\u3000\ntwo")).toHaveLength(1);
		expect(splitMarkdownBlocks("one\n \t\ntwo")).toHaveLength(2);
		expect(splitMarkdownBlocks("one\r\rtwo")).toHaveLength(1);
	});

	it("does not cut inside a list or an indented block", () => {
		expect(splitMarkdownBlocks("- a\n\n- b")).toHaveLength(1);
		expect(splitMarkdownBlocks("- a\n\n  b\n\ntext")).toHaveLength(2);
		expect(splitMarkdownBlocks("    a\n\n    b")).toHaveLength(1);
	});

	it("does not split text it cannot reason about", () => {
		expect(splitMarkdownBlocks("a\n\n[x]: https://example.com")).toHaveLength(1);
		expect(splitMarkdownBlocks("a\n\n[^1]: note")).toHaveLength(1);
		expect(splitMarkdownBlocks("[a]\n\n> [a]: /url")).toHaveLength(1);
		expect(splitMarkdownBlocks("[a]\n\n- [a]: /url")).toHaveLength(1);
		expect(splitMarkdownBlocks("[a]\n\n[a\nb]: /url")).toHaveLength(1);
		expect(splitMarkdownBlocks("[a]\n\n[a\\]]: /url")).toHaveLength(1);
		// Inside a fence it is code, not a definition.
		expect(splitMarkdownBlocks("[a]\n\n```\n[a]: /url\n```\n\nb")).toHaveLength(3);
		expect(splitMarkdownBlocks("a\n\n<div>b</div>")).toHaveLength(1);
	});

	it("handles a very long reply quickly", () => {
		const text = Array.from({ length: 5000 }, (_, i) => `paragraph ${i}`).join("\n\n");
		const started = performance.now();
		expect(splitMarkdownBlocks(text)).toHaveLength(5000);
		expect(performance.now() - started).toBeLessThan(250);
	});
});
