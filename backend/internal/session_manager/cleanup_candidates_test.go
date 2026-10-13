package sessionmanager

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestCleanup_LegacyCompletionMakesRepeatRunNoOp(t *testing.T) {
	for _, project := range []domain.ProjectID{"mer", ""} {
		for _, reclaim := range []ports.WorkspaceReclaim{ports.WorkspaceReclaimRemoved, ports.WorkspaceReclaimAlreadyAbsent} {
			t.Run(string(project)+"/"+string(reclaim), func(t *testing.T) {
				m, st, rt, ws := newManager()
				seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", RuntimeHandleID: "old", Branch: "ao/mer-1"})
				rec := st.sessions["mer-1"]
				rec.CleanupGeneration = 3
				st.sessions[rec.ID] = rec
				ws.destroyReclaim = reclaim
				first, err := m.Cleanup(context.Background(), project)
				if err != nil || len(first.Skipped) != 0 || len(first.Cleaned)+len(first.AlreadyGone) != 1 {
					t.Fatalf("first cleanup = %+v, err=%v", first, err)
				}
				facts, ok, err := st.GetSessionCleanupFacts(context.Background(), rec.ID)
				if err != nil || !ok || facts.SessionGeneration != rec.CleanupGeneration || facts.WorkspaceDisposition != domain.DispositionRemoved || facts.RuntimeReleasedAt.IsZero() {
					t.Fatalf("legacy completion facts = %+v, ok=%v, err=%v", facts, ok, err)
				}
				second, err := m.Cleanup(context.Background(), project)
				if err != nil || len(second.Cleaned)+len(second.AlreadyGone)+len(second.Skipped) != 0 {
					t.Fatalf("repeat cleanup = %+v, err=%v, want no candidates", second, err)
				}
				if rt.destroyed != 1 || ws.destroyed != 1 || !reflect.DeepEqual(st.sessions[rec.ID], rec) {
					t.Fatalf("repeat changed resources/history: runtimes=%d workspaces=%d session=%+v", rt.destroyed, ws.destroyed, st.sessions[rec.ID])
				}
			})
		}
	}
}

func TestCleanup_OnlyCurrentSuccessfulFactsSuppressCandidates(t *testing.T) {
	for _, tc := range []struct {
		name        string
		disposition domain.WorkspaceDisposition
		generation  int64
		terminated  bool
		wantCleanup bool
	}{
		{"removed", domain.DispositionRemoved, 2, true, false},
		{"not applicable", domain.DispositionNotApplicable, 2, true, false},
		{"stale removed", domain.DispositionRemoved, 1, true, true},
		{"missing", "", 0, true, true},
		{"pending", domain.DispositionPending, 2, true, true},
		{"dirty", domain.DispositionPreservedDirty, 2, true, true},
		{"failed", domain.DispositionFailed, 2, true, true},
		{"live", domain.DispositionPending, 2, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, st, rt, ws := newManager()
			rec := mkLive("mer-1")
			rec.IsTerminated, rec.CleanupGeneration = tc.terminated, 2
			st.sessions[rec.ID] = rec
			if tc.disposition != "" {
				st.cleanupFacts = map[domain.SessionID]domain.SessionCleanupRecord{rec.ID: {
					SessionID: rec.ID, SessionGeneration: tc.generation, WorkspaceDisposition: tc.disposition,
					NextAttemptAt: time.Now().Add(time.Hour),
				}}
			}
			res, err := m.Cleanup(context.Background(), "mer")
			if err != nil || (len(res.Cleaned) == 1) != tc.wantCleanup || len(res.Skipped)+len(res.AlreadyGone) != 0 {
				t.Fatalf("cleanup = %+v, err=%v, want cleanup=%v", res, err, tc.wantCleanup)
			}
			if (ws.destroyed == 1) != tc.wantCleanup || (rt.destroyed == 1) != tc.wantCleanup {
				t.Fatalf("resource attempts = %d/%d, want cleanup=%v", ws.destroyed, rt.destroyed, tc.wantCleanup)
			}
		})
	}
}

func TestCleanup_ProjectScopeLeavesOtherProjectsEligible(t *testing.T) {
	m, st, _, _ := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
	seedTerminal(st, "other-1", domain.SessionMetadata{WorkspacePath: "/ws/other-1"})
	other := st.sessions["other-1"]
	other.ProjectID = "other"
	st.sessions[other.ID] = other
	st.projects["other"] = domain.ProjectRecord{ID: "other", Path: "/repo/other", Config: testRoleAgents()}
	for _, project := range []domain.ProjectID{"mer", ""} {
		res, err := m.Cleanup(context.Background(), project)
		want := domain.SessionID("mer-1")
		if project == "" {
			want = other.ID
		}
		if err != nil || len(res.Cleaned) != 1 || res.Cleaned[0] != want {
			t.Fatalf("cleanup %q = %+v, err=%v, want only %s", project, res, err, want)
		}
	}
}

func TestCleanup_UnsuccessfulReclaimRemainsRetryable(t *testing.T) {
	for _, tc := range []struct {
		name        string
		err         error
		disposition domain.WorkspaceDisposition
	}{
		{"dirty", ports.ErrWorkspaceDirty, domain.DispositionPreservedDirty},
		{"deferred", ports.ErrWorkspaceDeferred, domain.DispositionFailed},
		{"unknown probe", errors.New("workspace probe unavailable"), domain.DispositionFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, st, _, ws := newManager()
			seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
			// An adapter's reclaim value is meaningless when it also returns an error.
			ws.destroyErr, ws.destroyReclaim = tc.err, ports.WorkspaceReclaimAlreadyAbsent
			for attempt := 0; attempt < 2; attempt++ {
				res, err := m.Cleanup(context.Background(), "mer")
				if err != nil || len(res.Skipped) != 1 || len(res.Cleaned)+len(res.AlreadyGone) != 0 {
					t.Fatalf("cleanup = %+v, err=%v, want preserved candidate", res, err)
				}
				facts, _, _ := st.GetSessionCleanupFacts(context.Background(), "mer-1")
				if facts.WorkspaceDisposition != tc.disposition {
					t.Fatalf("facts = %+v, want %s", facts, tc.disposition)
				}
			}
			if ws.destroyed != 2 {
				t.Fatalf("attempts = %d, want retry", ws.destroyed)
			}
		})
	}
}

func TestCleanup_RuntimeFailureDoesNotConfirmAbsence(t *testing.T) {
	m, st, rt, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", RuntimeHandleID: "unknown"})
	rt.destroyErr, rt.aliveErr = errors.New("runtime unreachable"), errors.New("probe unavailable")
	for attempt := 0; attempt < 2; attempt++ {
		res, err := m.Cleanup(context.Background(), "mer")
		if err != nil || len(res.Skipped) != 1 || res.Skipped[0].Reason != "runtime teardown failed" || len(res.AlreadyGone)+len(res.Cleaned) != 0 {
			t.Fatalf("cleanup = %+v, err=%v", res, err)
		}
	}
	if ws.destroyed != 0 || rt.destroyed != 2 || len(st.cleanupFacts) != 0 {
		t.Fatalf("unconfirmed runtime lost its candidate/workspace: destroys=%d/%d facts=%v", rt.destroyed, ws.destroyed, st.cleanupFacts)
	}
}

type cleanupRestoredStore struct{ *fakeStore }

func (s cleanupRestoredStore) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	recs, err := s.fakeStore.ListSessions(ctx, project)
	for _, rec := range recs {
		rec.IsTerminated = false // Restore wins after the scan, before the operation guard.
		s.sessions[rec.ID] = rec
	}
	return recs, err
}

func TestCleanup_RechecksRestoredSessionBeforeRuntimeTeardown(t *testing.T) {
	m, st, rt, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", RuntimeHandleID: "live"})
	m.store = cleanupRestoredStore{st}
	res, err := m.Cleanup(context.Background(), "mer")
	if err != nil || len(res.Cleaned)+len(res.AlreadyGone)+len(res.Skipped) != 0 || rt.destroyed+ws.destroyed != 0 || len(st.cleanupFacts) != 0 {
		t.Fatalf("restored session changed: result=%+v err=%v destroys=%d/%d facts=%v", res, err, rt.destroyed, ws.destroyed, st.cleanupFacts)
	}
}

type cleanupUnavailableFactsStore struct {
	*fakeStore
	readErr, writeErr error
}

func (s cleanupUnavailableFactsStore) GetSessionCleanupFacts(ctx context.Context, id domain.SessionID) (domain.SessionCleanupRecord, bool, error) {
	if s.readErr != nil {
		return domain.SessionCleanupRecord{}, false, s.readErr
	}
	return s.fakeStore.GetSessionCleanupFacts(ctx, id)
}

func (s cleanupUnavailableFactsStore) UpsertSessionCleanupFacts(ctx context.Context, facts domain.SessionCleanupRecord) error {
	if s.writeErr != nil {
		return s.writeErr
	}
	return s.fakeStore.UpsertSessionCleanupFacts(ctx, facts)
}

func TestCleanup_UnavailableFactsDoNotConfirmCompletion(t *testing.T) {
	for _, readFailure := range []bool{true, false} {
		t.Run(map[bool]string{true: "read", false: "write"}[readFailure], func(t *testing.T) {
			m, st, rt, ws := newManager()
			seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
			unavailable := cleanupUnavailableFactsStore{fakeStore: st}
			if readFailure {
				unavailable.readErr = errors.New("facts unavailable")
			} else {
				unavailable.writeErr = errors.New("facts unavailable")
			}
			m.store = unavailable
			res, err := m.Cleanup(context.Background(), "mer")
			if err != nil || len(res.Skipped) != 1 || len(res.Cleaned)+len(res.AlreadyGone) != 0 || ws.destroyed+rt.destroyed != 0 || len(st.cleanupFacts) != 0 {
				t.Fatalf("unavailable facts caused cleanup: result=%+v err=%v destroys=%d/%d", res, err, rt.destroyed, ws.destroyed)
			}
		})
	}
}

func TestCleanup_LegacyAlreadyGoneCompletionSurvivesStoreReopen(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	st, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Error(err)
		}
	})
	now := time.Now().UTC()
	if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "mer", Path: "/repo/mer", RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	created, err := st.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IsTerminated: true, CleanupGeneration: 4, Mode: domain.SessionModeTUI,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/legacy", Branch: "ao/legacy"},
		Activity: domain.Activity{State: domain.ActivityExited}, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	before, _, err := st.GetSession(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	m, _, _, ws := newManager()
	m.store = st
	ws.destroyReclaim = ports.WorkspaceReclaimAlreadyAbsent
	base, err := st.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	res, err := m.Cleanup(ctx, "mer")
	if err != nil || len(res.AlreadyGone) != 1 || res.AlreadyGone[0] != created.ID {
		t.Fatalf("legacy cleanup = %+v, err=%v", res, err)
	}
	events, err := st.EventsAfter(ctx, base, 100)
	if err != nil || len(events) != 2 {
		t.Fatalf("cleanup CDC events = %+v, err=%v, want pending/completion events", events, err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = sqlite.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	m.store = st
	res, err = m.Cleanup(ctx, "")
	if err != nil || len(res.Cleaned)+len(res.AlreadyGone)+len(res.Skipped) != 0 || ws.destroyed != 1 {
		t.Fatalf("cleanup after reopen = %+v, err=%v, destroys=%d", res, err, ws.destroyed)
	}
	after, ok, err := st.GetSession(ctx, created.ID)
	if err != nil || !ok || !reflect.DeepEqual(after, before) {
		t.Fatalf("archived session/branch changed: after=%+v, before=%+v, err=%v", after, before, err)
	}
	facts, ok, err := st.GetSessionCleanupFacts(ctx, created.ID)
	if err != nil || !ok || facts.WorkspaceDisposition != domain.DispositionRemoved || facts.SessionGeneration != after.CleanupGeneration {
		t.Fatalf("durable completed facts = %+v, ok=%v err=%v", facts, ok, err)
	}
}
