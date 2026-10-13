# Chat responsiveness

This change reduces AO's event-delivery and renderer overhead. It does not change provider inference, session lifecycle, daemon/API contracts, durable messages, approvals, model selection, or the chat layout.

## What was detected and changed

| Reproduction / finding | Change | Behavior retained |
| --- | --- | --- |
| CDC events arriving every 100 ms repeatedly reset the shared 150 ms debounce, delaying refresh until traffic stops. | Keep the first event's 150 ms deadline. Coalesce IDs, let active fetches finish, and queue a catch-up when an event predates their completion. | Targeted routing, full reconnect refresh, account/workspace boundaries, and durable snapshots. |
| Already-received text drains at 58–720 graphemes/second; long bursts stay buffered. `useRef` initializers also segment complete strings on each render. | Segment once per changed text; append only new graphemes; flush received backlog on the first animation frame at/after 200 ms from scheduling. **Superseded:** the drain no longer flushes at a deadline; it reveals a decaying share of the backlog (~140 ms time constant, at most ~30 updates/s) and shows the current text at once when the tab was hidden or stalled for over a second. | Initial snapshots, completed messages, visible-prefix corrections, Unicode reconciliation, copy, reduced motion, and the Markdown parser. |
| Scrolling scans and measures every loaded human-prompt anchor repeatedly. | Cache content-space positions; invalidate on content mutations, layout synchronization, dimensions, and resize observation. | In the measured implementation, every loaded turn stayed mounted. The current long-history timeline virtualizes offscreen turns; see [the current limits](#deliberate-limits). |
| Large syntax blocks run tokenization on the renderer despite an async function signature. | Use a lazy module worker above 20,000 characters with the same grammar engine. | Small warm synchronous highlights, grammar aliases, token output, escaping, source text, and copying. |

The worker has bounded pending work (32 jobs / 1,000,000 source characters) and a 10-second timeout. Worker failure, unsupported workers, or an oversized/saturated request leave readable plain code instead of performing expensive synchronous fallback. Colorization may therefore be omitted in these cases; source text is retained. Mermaid remains available and is untouched.

## Measurement method

The opt-in Playwright fixture imports the actual AO renderer components and event transport. It uses deterministic synthetic inputs and a fake Electron bridge; these are live browser measurements, **not real-provider latency measurements or a full packaged-app end-to-end test**.

- **Delivery:** 20 conversation CDC events, 100 ms apart, an active TanStack Query observer, and a simulated 30 ms query. Let the bridge's initial lifecycle refresh settle before the timed workload. Record actual fetch starts/completions and whether they occur before the stream ends.
- **Streaming:** deliver a 997 UTF-16-character Unicode burst after the initial snapshot. Record time until rendered text exactly matches the received string, then check completion restores the copy button. This measures received-to-DOM-visible lag; it does not instrument display scanout.
- **Highlighting:** warm the existing TypeScript grammar, highlight 10,000 lines (537,779 UTF-16 characters), and sample the main event loop every 4 ms. Record elapsed highlighting time separately from the worst callback gap. This isolates the tokenizer API and excludes React's rendering of the returned token tree. Worker startup/transfer is included.
- **Scrolling:** the measured implementation mounted 250 fixture turns, waited for fonts/layout, then performed 120 scroll steps. It counted actual anchor `getBoundingClientRect()` calls, asserted all 250 anchors remained mounted, and recorded frame gaps. The current implementation virtualizes offscreen turns; this historical measurement captures the pre-virtualization scroll-cache change and does not characterize current mounted DOM range.

Baseline is commit `a96322315`. The identical fixture files are copied into the baseline checkout. Final measurements run serially with one Playwright worker, three repetitions per workload, without overlapping test/build jobs. Raw records include browser, Node version, OS/architecture, CPU count, viewport, timestamp, and every sampled gap. Three runs support descriptive medians/ranges, not population percentiles or a universal speedup claim. The host is a shared developer machine.

## Results

Apple M5, 10 logical CPUs, 24 GiB RAM; macOS arm64; Node 24.20.0; Chromium 148.0.7778.96; 1440 × 1000 viewport. Implementation source was `cc6042e71` (later commits package evidence and CI setup). Values are medians with three-run ranges. See [all raw samples](measurements.json).

| Measurement | Baseline | After |
| --- | ---: | ---: |
| First fetch start (ms) | 2,070.2 (2,069.5–2,071.7) | 151.6 (151.4–151.9) |
| Fetch starts during the stream | 0.0 (0.0–0.0) | 10.0 (10.0–10.0) |
| Received burst fully visible (ms) | 2,856.7 (2,850.6–2,857.8) | 213.3 (213.1–215.8) |
| Highlight maximum event-loop gap (ms) | 65.0 (63.0–68.9) | 27.2 (26.3–30.5) |
| Highlight total completion time (ms) | 62.6 (60.6–66.8) | 128.5 (125.1–160.2) |
| Anchor geometry reads | 60,001.0 (60,001.0–60,252.0) | 251.0 (251.0–251.0) |
| Maximum scroll frame gap per run (ms) | 25.8 (17.7–33.2) | 17.6 (16.7–25.0) |

The "received burst fully visible" figure was measured under the 200 ms flush deadline. The smoothed drain takes longer on purpose (a 10,000-character burst needs about a second or more), so re-run the streaming workload before quoting that number.

Continuous traffic now causes ten fetches before the stream ends, rather than waiting for silence. In the pre-virtualization scroll-cache measurements, repeated anchor measurements fell by 99.6% while all 250 turns stayed mounted.

**Tradeoff:** initial worker highlighting takes about twice as long overall, including startup/module loading and transfer in the Vite development renderer, while the worst main-thread gap is substantially lower. Plain code remains available while colorization is pending. The scroll frame-gap ranges overlap; this small sample supports reduced layout work, not a general FPS claim.

## Reproduce

From `frontend/`, using the lockfile dependencies and Playwright Chromium:

```sh
AO_PERF_BENCH=1 AO_PERF_LABEL=after AO_PERF_DIR="$HOME/.ao/validation/chat-performance" \
  AO_E2E_PORT=5292 CI=true npm run test:e2e -- \
  e2e/chat-performance.spec.ts --workers=1 --repeat-each=3
```

Create a detached baseline worktree at `a96322315`, install its lockfile dependencies, and copy `frontend/e2e/chat-performance.spec.ts` plus `frontend/e2e/performance/` into it. Repeat with `AO_PERF_LABEL=baseline` and another free port. Timings are intentionally not CI thresholds; unit regressions enforce scheduling, catch-up, cleanup, grapheme integrity, and geometry reuse.

## Verification

Local validation used Node 24.20.0 on macOS:

| Check | Result |
| --- | --- |
| Full frontend Vitest suite | 3,751 passed, 6 skipped, 275 files |
| Full renderer smoke suite (`@T0` / `@P0`) | 52 passed |
| Frontend and E2E TypeScript checks | Passed |
| Cloud client generation/drift, typecheck, tests, build, package dry-run | Passed |
| Product UI typecheck, tests, build, package dry-run | Passed |
| Pinned agent-browser runtime preparation | Passed; used by full frontend tests |
| Production Vite renderer build | Passed; separate 72 KB highlighting worker emitted |
| Built worker under Electron / `app://` / production CSP | Passed |
| Before/after controlled browser workloads | 12 runs per checkout; text and mounted-turn integrity checked |
| Gitleaks v7.4.0 with the workflow config and PR commit list | 9 commits scanned; no leaks |

The first remote renderer-smoke run exposed a clean-install gap: the benchmark fixture imports real renderer components and shared product-ui source, but that job did not install product-ui dependencies. The workflow now installs them before E2E typechecking. Removing those dependencies locally reproduced the failure; the exact new install step restored passing typechecks, followed by all 52 renderer smoke tests passing.

One initial complete Vitest run missed the unchanged settings form's temporary “Saved” indicator (3,750 passed / 1 failed). The full 40-test settings file passed separately on both baseline and branch, then the complete suite passed on rerun. Early overlapping browser runs timed out at startup under host swapping; the final full browser suite ran serially and passed. Initial native dependency setup also needed the pinned Electron binary and a Node 24 SQLite rebuild; these environment repairs changed no dependency manifest or lockfile.

The requested `npx @redwoodjs/agent-ci run --all` wrapper stopped before dispatch because the release-artifact workflow requires `VITE_WORKOS_CLIENT_ID`. No release/publishing job was executed. Docker became unavailable before the secret scan, so the pinned Gitleaks v7.4.0 source was built locally and run against a normal disposable clone; the scanner reported all nine PR commits scanned. Applicable frontend workflow commands were therefore run directly; the remote Linux checks remain authoritative for their runner (see the PR Checks tab). Backend/API, mobile, and release-platform workflows are outside this frontend-only diff's path triggers.


Native development smoke used an isolated daemon at `127.0.0.1:5322`, renderer at `localhost:5174`, and data/profile/run state under `~/.ao/performance-dev`. The actual Electron window displayed the home screen, and `/api/v1/projects` plus `/api/v1/sessions` returned 200. No existing AO project/session was changed. `ao preview` was attempted but correctly refused because this Codex task has no `AO_SESSION_ID`.

A separate Electron 33.4.11 smoke loaded the built highlighting worker over `app://renderer`, using AO's scheme privileges and the generated production CSP without relaxing it. The returned token tree preserved all 51,000 source characters; see [worker result](built-worker-smoke.json). This tests packaged-origin worker compatibility, not an installer or signed release.

## Huge live turn with a long queue

Turn-level virtualization never windows a single turn, so a long-running turn with many loaded rows mounts all of them. Before this change every refresh of that live turn re-rendered every row, and every refresh also re-rendered each queued-message dock row.

Fixture: `performanceHarness.hugeTurn()` in `frontend/e2e/performance/harness.tsx`: one live turn with 900 loaded rows, 28 queued messages with report batches, and a snapshot of about 600 KB that is rebuilt as fresh objects on each refresh (as a TanStack Query refetch does). Run it with:

```bash
cd frontend
AO_PERF_BENCH=1 AO_PERF_CPU_THROTTLE=4 AO_PERF_DIR=/tmp/ao-perf \
  npx playwright test chat-performance --grep hugeTurn
```

Optional env: `AO_PERF_OPTIONS` (JSON: `phases`, `refreshes`), `AO_PERF_CPUPROFILE=<path>`, `AO_PERF_TRACE=<path>`.

Profile finding: a refresh changes only the tail of the turn, but `TurnGroup` rebuilt its runs, `TimelineItem` and `ActivityRun` were not memoized, the queue dock rows were not memoized, and `useConversationCommands` passes fresh callbacks each render. The CPU profile of 40 refreshes at 4x throttle attributed about 1010 ms to `ActivityRun`, 249 ms to `TimelineItem` and about 270 ms to the queue dock rows.

Fix: identity-stabilize the runs inside a turn (`useStableList`), memoize `TimelineItem`, `ActivityRun` and the sortable queue rows, and give the queue dock stable callbacks and a stable list. `ChatWorkspace.liveTurnRefresh.test.tsx` pins the behavior: a refetched snapshot with one extra command re-renders at most 2 activity rows (was 41), and an unchanged queue re-renders 0 dock rows (was 6).

| Metric (median, dev-mode React) | Before | After |
| --- | --- | --- |
| Refresh wall time, 1x CPU | 30 ms | 12 ms |
| Refresh wall time, 4x CPU | 230 ms | 61 ms |
| Max commit during refresh, 1x / 4x | 62 / 287 ms | 11 / 58 ms |
| Total render time over 12 refreshes, 1x / 4x | 279 / 2078 ms | 135 / 865 ms |
| CPU profile, 40 refreshes at 4x (`hugeTurn`) | 9642 ms | 2634 ms |
| Idle keystroke | unchanged | unchanged |
| Scroll p95 frame, 4x | 24 ms | 18.5 ms |

Caveats: numbers come from dev-mode React, which inflates absolute values (a production-mode run did not work in this harness). Lag was not reproducible at 1x with only 160-200 loaded rows; it needs many loaded rows.

Not fixed: a keystroke while a refresh lands still takes about 55 ms at 4x. That time is the browser's style/layout/paint/layerize work for roughly 8K DOM nodes, not React; `content-visibility: auto` did not help. Removing it needs fewer mounted rows in a live turn, for example windowing or folding older runs ("N earlier steps"), which changes the UX, or an incremental history refresh (see the limits below). The streaming Markdown re-parse is a constant cost independent of turn size.

### In-turn row windowing

A turn with more than 40 runs now swaps rows far from the viewport (beyond 150% of its height) for an empty box of their exact measured height (`WindowedRow`). Scroll height and positions do not change; focus, selection, an open disclosure (a row with `aria-expanded="true"` stays mounted, since expanded commands, diffs and tool calls keep that state in the row), a pinned edit and a jump to a message (the box is scrolled into view and the row mounts) keep working. Browser Find and DOM selection cover only mounted rows, as with turn virtualization.

Same fixture, 3 runs, dev-mode React:

| Metric | PR #4 | Windowed |
| --- | --- | --- |
| DOM nodes | 8110 | 1643 |
| Refresh wall time, 1x / 4x | 12 / 76 ms | 16 / 84 ms |
| Keystroke during refresh, 1x / 4x | 4.3 / 66 ms | 4.0 / 60 ms |
| Scroll frame p95 / max, 1x | 9.2 / 9.3 ms | 9.3 / 25 ms |
| Scroll frame p95 / max, 4x | 25 / 92 ms | 59 / 209 ms |

Windowing cuts the DOM by 80% but does not shorten a keystroke during a refresh, so the layout and paint cost of the DOM was not what delayed it. The delay is the live reply's own re-render: each refresh triggers about three async commits of roughly 33 ms at 4x, mostly the streaming Markdown re-parse and its effects, and with an unchanged snapshot the same keystroke takes 13.5 ms. Scrolling gets more expensive because rows mount as they approach the viewport.

## Screenshots

No layout redesign is included. The before/after images show the same long-chat fixture; the native image identifies the isolated app smoke.

| Before | After |
| --- | --- |
| ![Before: 250-turn AO chat fixture](assets/baseline-history.png) | ![After: same 250-turn AO chat fixture](assets/after-history.png) |

![Native AO startup with isolated data](assets/native-home.png)

## Deliberate limits

Long conversations now virtualize turn rows after 20 groups. Offscreen turns unmount, so browser Find, DOM-based text selection/copy, and sequential screen-reader navigation cover only the mounted range. Minimap navigation still targets every loaded turn. Activity disclosure choices are retained when a row leaves and re-enters the mounted range. This trades full-transcript DOM access for lower rendering cost on large histories.

History still refreshes in full. CDC currently identifies the conversation but not which item/range changed; old running tools and rewritten branches can change outside the newest page. Replacing only the newest page can also skip an item at a shifted pagination boundary. Safe incremental history needs an explicit version/change-scope contract, not a frontend shortcut.

Incremental Markdown parsing remains excluded because it could change cross-block Markdown behavior. Persistence timing is unchanged. The 200 ms streaming limit is a scheduling target: a blocked/hidden renderer can only display text when the browser schedules a frame.
