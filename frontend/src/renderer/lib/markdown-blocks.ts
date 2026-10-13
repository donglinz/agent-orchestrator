/**
 * Splits streaming markdown into pieces that can be parsed and rendered on their own.
 *
 * A reply that streams is re-parsed in full on every update, so an update costs
 * the length of the whole reply even though only its last paragraph changed. Cut at
 * the places where the markdown cannot tell the difference and the finished pieces
 * can be memoized by their text.
 *
 * A cut is made only where it cannot change how either side renders: just before a
 * line with no indentation that follows a blank line, outside a fenced code block.
 * A blank line ends every paragraph, table, quote and list item that is not
 * indented under it, and an unindented line cannot continue an indented one.
 * Anything this cannot reason about turns splitting off for the whole text, so the
 * result is then exactly what parsing it in one piece produces:
 *
 *   - link reference and footnote definitions, which apply to the whole document
 *     wherever they appear, including inside quotes and list items;
 *   - HTML, whose blocks can run across blank lines;
 *   - a line that starts like a list item, which can continue a list across the
 *     blank line and change whether it is loose.
 *
 * The pieces always concatenate back to the input.
 */

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Every definition ends its label with "]:". Matching only that, on any line outside a
// fence, also catches definitions that start inside a quote or list item, labels that
// span lines and labels with an escaped bracket. Prose that happens to contain it just
// isn't split.
const DEFINITION_MARK = "]:";
// A blank line holds only spaces and tabs. String.trim also strips NBSP and other Unicode
// space, which Markdown treats as text.
const BLANK_LINE = /^[ \t]*$/;
const HTML_START = /^ {0,3}</;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

export function splitMarkdownBlocks(text: string): string[] {
	// A bare carriage return is a line ending to Markdown but not to this scanner.
	if (/\r(?!\n)/.test(text)) return [text];
	const pieces: string[] = [];
	let pieceStart = 0;
	let fence: { closing: RegExp } | undefined;
	let previousBlank = false;
	let offset = 0;

	// Lines keep their terminators so offsets stay exact.
	for (const line of text.split(/(?<=\n)/)) {
		const content = line.replace(/\r?\n$/, "");
		const lineStart = offset;
		offset += line.length;

		if (fence) {
			if (fence.closing.test(content)) fence = undefined;
			previousBlank = false;
			continue;
		}
		if (content.includes(DEFINITION_MARK) || HTML_START.test(content)) return [text];

		const blank = BLANK_LINE.test(content);
		if (!blank) {
			const opening = OPENING_FENCE.exec(content);
			const startsFence = opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"));
			// A cut goes before an unindented line that follows a blank one. A line that
			// opens a fence qualifies: the fence is a block of its own.
			if (previousBlank && lineStart > pieceStart && !/^[ \t]/.test(content) && !LIST_MARKER.test(content)) {
				pieces.push(text.slice(pieceStart, lineStart));
				pieceStart = lineStart;
			}
			if (startsFence) fence = { closing: new RegExp(`^ {0,3}${opening[1]![0]}{${opening[1]!.length},}[ \\t]*$`) };
		}
		previousBlank = blank;
	}
	pieces.push(text.slice(pieceStart));
	return pieces;
}
