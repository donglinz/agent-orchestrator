import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { installFakeBridge } from "./support/fake-bridge";
import type { performanceHarness } from "./performance/harness";

declare global {
	interface Window {
		performanceHarness: typeof performanceHarness;
	}
}

test.describe("live renderer performance workloads", () => {
	test.skip(
		process.env.AO_PERF_BENCH !== "1",
		"Opt-in benchmark; timings are evidence, not hardware-dependent CI assertions",
	);
	test.use({ viewport: { width: 1440, height: 1000 } });
	for (const workload of [
		"events",
		"streaming",
		"highlighting",
		"history",
		"hugeTurn",
	] as const) {
		test(workload, async ({ page, browser }, testInfo) => {
			test.setTimeout(120_000);
			await installFakeBridge(page);
			await page.emulateMedia({ reducedMotion: "no-preference" });
			await page.goto("/e2e/performance/harness.html");
			await page.waitForFunction(() => Boolean(window.performanceHarness));
			// Optional CPU slowdown (for example 4) to approximate a slower laptop.
			const cpuThrottle = Number(process.env.AO_PERF_CPU_THROTTLE ?? 1);
			const cdp = await page.context().newCDPSession(page);
			if (cpuThrottle > 1) {
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
			}
			// Optional V8 CPU profile (.cpuprofile). hugeTurn marks the span it wants
			// profiled; other workloads are profiled whole.
			const cpuProfilePath = process.env.AO_PERF_CPUPROFILE;
			let profile: unknown;
			let browserMetrics: Record<string, number> | undefined;
			const startProfile = async () => {
				await cdp.send("Profiler.enable");
				await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
				await cdp.send("Profiler.start");
			};
			const stopProfile = async () => {
				profile = (await cdp.send("Profiler.stop")).profile;
			};
			// Browser-side cost the JS profile cannot attribute: style, layout, script.
			const metricNames = ["LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount"];
			let metricsBefore: Record<string, number> = {};
			const readMetrics = async () =>
				Object.fromEntries(
					(await cdp.send("Performance.getMetrics")).metrics
						.filter((metric) => metricNames.includes(metric.name))
						.map((metric) => [metric.name, metric.value]),
				);
			// Optional Chromium trace of the profiled span: where style, layout and paint go.
			const tracePath = process.env.AO_PERF_TRACE;
			let traceStopped: Promise<void> | undefined;
			if (tracePath && workload === "hugeTurn") {
				page.on("console", (message) => {
					if (message.text() === "ao-perf:profile-start")
						void browser.startTracing(page, {
							path: tracePath,
							categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "cc"],
						});
					if (message.text() === "ao-perf:profile-stop") traceStopped = browser.stopTracing().then(() => undefined);
				});
			}
			if (workload === "hugeTurn") {
				await cdp.send("Performance.enable");
				page.on("console", (message) => {
					if (message.text() === "ao-perf:profile-start") void readMetrics().then((m) => (metricsBefore = m));
					if (message.text() === "ao-perf:profile-stop")
						void readMetrics().then((after) => {
							browserMetrics = Object.fromEntries(
								metricNames.map((name) => [name, Math.round(((after[name] ?? 0) - (metricsBefore[name] ?? 0)) * (name.endsWith("Count") ? 1 : 1000) * 10) / 10]),
							);
						});
				});
			}
			if (cpuProfilePath) {
				if (workload === "hugeTurn") {
					page.on("console", (message) => {
						if (message.text() === "ao-perf:profile-start") void startProfile();
						if (message.text() === "ao-perf:profile-stop") void stopProfile();
					});
				} else {
					await startProfile();
				}
			}
			const result = await page.evaluate(
				async ({ name, options }): Promise<Record<string, unknown>> =>
					await (window.performanceHarness[name] as (o?: unknown) => Promise<Record<string, unknown>>)(options),
				{
					name: workload,
					options: process.env.AO_PERF_OPTIONS ? JSON.parse(process.env.AO_PERF_OPTIONS) : undefined,
				},
			);
			await traceStopped;
			if (cpuProfilePath) {
				if (workload !== "hugeTurn") await stopProfile();
				await mkdir(path.dirname(cpuProfilePath), { recursive: true });
				await writeFile(cpuProfilePath, JSON.stringify(profile));
			}
			if ("exact" in result) expect(result.exact).toBe(true);
			if ("textPreserved" in result) expect(result.textPreserved).toBe(true);
			if (workload === "history") expect(result.mountedTurns).toBe(250);
			const label = process.env.AO_PERF_LABEL ?? "sample";
			const record = {
				label,
				cpuThrottle,
				browserMetrics,
				commit: execFileSync("git", ["rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
				workload,
				repeat: testInfo.repeatEachIndex,
				browser: browser.version(),
				node: process.version,
				platform: os.platform(),
				arch: os.arch(),
				cpus: os.cpus().length,
				cpuModel: os.cpus()[0]?.model,
				totalMemoryBytes: os.totalmem(),
				viewport: page.viewportSize(),
				timestamp: new Date().toISOString(),
				result,
			};
			await testInfo.attach("measurements", {
				body: JSON.stringify(record, null, 2),
				contentType: "application/json",
			});
			const output = process.env.AO_PERF_DIR;
			if (output) {
				await mkdir(output, { recursive: true });
				await writeFile(
					path.join(
						output,
						`${label}-${workload}-${testInfo.repeatEachIndex}.json`,
					),
					JSON.stringify(record, null, 2) + "\n",
				);
				if (workload === "history" && testInfo.repeatEachIndex === 0)
					await page.screenshot({
						path: path.join(output, `${label}-history.png`),
					});
			}
		});
	}
});
