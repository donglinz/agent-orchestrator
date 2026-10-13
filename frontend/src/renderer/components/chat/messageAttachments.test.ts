import { describe, expect, it } from "vitest";
import { humanVisibleText, labelInlineImages, proseBesideImages, splitInlineImagePaths, splitWorkerReports } from "./messageAttachments";

const a = ".ao/attachments/attachment-a.png";
const b = ".ao/attachments/attachment-b.png";

describe("inline image paths", () => {
	it("leaves a staged path inside a longer path as text", () => {
		expect(splitInlineImagePaths(`/wt/${a} and ${a}`)).toEqual([{ text: `/wt/${a} and ` }, { path: a }]);
	});

	it("sends no prose for a message that is only its images", () => {
		expect(proseBesideImages(`${a} ${b}`, [a, b])).toBe("");
	});

	// Only the editor knows which paths are chips; a typed path is the user's text.
	it("sends a typed path untouched, attached or not", () => {
		expect(proseBesideImages(`No, look at ${b} again`, [a])).toBe(`No, look at ${b} again`);
		expect(proseBesideImages(`see\n${b}\nthanks`, [])).toBe(`see\n${b}\nthanks`);
		expect(proseBesideImages(b, [])).toBe(b);
	});

	it("labels attached inline images for one-line surfaces and keeps the reference block", () => {
		const block = `\n\nAttached files (read these files in the workspace):\n- ${a}\n- ${b}`;
		expect(labelInlineImages(`make ${b} like ${a}${block}`)).toBe(`make [Image 2] like [Image 1]${block}`);
	});
});

describe("worker report envelope", () => {
	const reports = "\n\n<ao-worker-reports>\nReports since your previous turn:\n\n[done] [worker](ao://sessions/project/worker)\nFinished\n</ao-worker-reports>";

	it("splits the trailing envelope from the human text and keeps it verbatim", () => {
		expect(splitWorkerReports(`Please continue${reports}`)).toEqual({ visible: "Please continue", reports });
		expect(humanVisibleText(`Please continue${reports}`)).toBe("Please continue");
	});

	it("leaves text without a trailing envelope untouched", () => {
		const quoted = "see <ao-worker-reports>\nx\n</ao-worker-reports> inline";
		expect(splitWorkerReports(quoted)).toEqual({ visible: quoted, reports: "" });
		expect(splitWorkerReports("plain")).toEqual({ visible: "plain", reports: "" });
	});
});
