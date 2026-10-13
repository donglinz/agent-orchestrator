import { expect, test, type Page } from "@playwright/test";
import { installFakeAgent } from "./support/fake-bridge";

const sessionId = "chat-find";
const turnCount = 120;
const needleTurn = 24;
const now = "2026-10-14T08:00:00Z";

/** A long history: every turn has a prompt, folded tool calls, and an answer. */
function longConversation() {
	const turns = [];
	const messages = [];
	const activities = [];
	let sequence = 0;
	for (let turn = 0; turn < turnCount; turn += 1) {
		const turnId = `turn-${turn}`;
		turns.push({ id: turnId, state: "completed", requestedAt: now, startedAt: now, completedAt: now });
		messages.push({
			kind: "message",
			id: `prompt-${turn}`,
			turnId,
			sequence: (sequence += 1),
			revision: 0,
			role: "user",
			origin: "human",
			text: `Question ${turn}: how does the snapshot handler work?`,
			streaming: false,
			createdAt: now,
		});
		for (let call = 0; call < 3; call += 1) {
			activities.push({
				kind: "activity",
				id: `call-${turn}-${call}`,
				turnId,
				sequence: (sequence += 1),
				revision: 0,
				activityKind: "command",
				status: "completed",
				summary: `Ran step ${call} for turn ${turn}`,
				detail: {
					command: turn === needleTurn && call === 1 ? "quokka-needle --verbose" : `step-${call} --turn ${turn}`,
					exitCode: 0,
				},
				createdAt: now,
			});
		}
		messages.push({
			kind: "message",
			id: `answer-${turn}`,
			turnId,
			sequence: (sequence += 1),
			revision: 0,
			role: "assistant",
			origin: "provider",
			text: `Answer ${turn}: it reads the durable snapshot.`,
			streaming: false,
			createdAt: now,
		});
	}
	return { turns, messages, activities, latestSequence: sequence };
}

async function openLongChat(page: Page) {
	await installFakeAgent(page, {
		workers: [{ id: sessionId, title: "Find in chat", mode: "chat" }],
	});
	const { turns, messages, activities, latestSequence } = longConversation();
	await page.route(`**/api/v1/sessions/${sessionId}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/conversation")) {
			await route.fulfill({
				json: {
					conversationId: "conversation-chat-find",
					sessionId,
					harness: "codex",
					mode: "chat",
					controller: "ready",
					latestSequence,
					oldestSequence: 1,
					hasMoreBefore: false,
					turns,
					messages,
					activities,
					settings: {},
				},
			});
			return;
		}
		if (path.endsWith("/conversation/models")) {
			await route.fulfill({ json: { models: [], selected: {} } });
			return;
		}
		if (path.endsWith("/conversation/skills")) {
			await route.fulfill({ json: { skills: [] } });
			return;
		}
		if (path.endsWith("/workspace/files")) {
			await route.fulfill({ json: { files: [], truncated: false } });
			return;
		}
		if (path.endsWith("/interface-transition")) {
			await route.fulfill({ json: { supported: true, targetMode: "tui" } });
			return;
		}
		await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "not found" } } });
	});
	await page.goto(`/#/projects/fake-proj/sessions/${sessionId}`);
	await expect(page.getByRole("log")).toBeVisible();
}

test.describe("in-chat find @T0", () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test("finds a folded tool call far above the virtualized window and returns focus on Escape", async ({ page }) => {
		await openLongChat(page);
		const composer = page.getByLabel("Message the agent");
		await composer.click();
		const needleRow = page.locator('[data-chat-find-id="call-24-1"]');
		await expect(needleRow).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+F");
		const input = page.getByRole("textbox", { name: "Find in chat" });
		await expect(input).toBeFocused();
		await input.fill("QUOKKA-needle");

		await expect(page.getByTestId("chat-find-count")).toHaveText("1 of 1");
		// The turn is outside the virtualized window and its calls are folded: find
		// must mount the turn, open "Worked for" and the run, and scroll to the row.
		await expect(needleRow).toBeVisible();
		await expect(needleRow).toBeInViewport();
		await expect(needleRow).toContainText("quokka-needle --verbose");
		await expect
			.poll(() =>
				page.evaluate(() => {
					const highlights = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
					return highlights?.get("chat-find-active")?.size ?? 0;
				}),
			)
			.toBe(1);

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("chat-find-bar")).toHaveCount(0);
		await expect(composer).toBeFocused();
	});

	test("starts near the reader and steps with Enter and Shift+Enter, wrapping at the ends", async ({ page }) => {
		await openLongChat(page);
		await page.getByLabel("Message the agent").click();
		await page.keyboard.press("ControlOrMeta+F");
		await page.getByRole("textbox", { name: "Find in chat" }).fill("how does the snapshot");
		const count = page.getByTestId("chat-find-count");
		await expect(count).toHaveText(new RegExp(`^\\d+ of ${turnCount}$`));
		const position = async () => Number((await count.innerText()).split(" of ")[0]);

		// The chat opens at its latest turn, so the first match is near the end,
		// not the oldest message.
		const start = await position();
		expect(start).toBeGreaterThan(turnCount - 10);

		await page.keyboard.press("Shift+Enter");
		await expect(count).toHaveText(`${start - 1} of ${turnCount}`);
		await page.keyboard.press("Enter");
		await expect(count).toHaveText(`${start} of ${turnCount}`);
		for (let step = start; step < turnCount; step += 1) await page.keyboard.press("Enter");
		await expect(count).toHaveText(`${turnCount} of ${turnCount}`);
		await page.keyboard.press("Enter");
		await expect(count).toHaveText(`1 of ${turnCount}`);
		await expect(page.locator('[data-chat-find-id="prompt-0"]')).toBeInViewport();
	});
});
