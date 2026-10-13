package chat_test

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func TestQueuedEditAttachmentChanges(t *testing.T) {
	zero := int64(0)
	one := int64(1)
	tenMiB := ports.ChatContent{Type: "image", MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString(make([]byte, 10<<20))}
	overTenMiB := ports.ChatContent{Type: "image", MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString(make([]byte, (10<<20)+1))}
	fiveMiB := ports.ChatContent{Type: "image", MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString(make([]byte, 5<<20))}
	overFiveMiB := ports.ChatContent{Type: "image", MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString(make([]byte, (5<<20)+1))}
	atLimit := []ports.ChatContent{tenMiB, tenMiB, fiveMiB}
	atLimitData := []string{tenMiB.Data, tenMiB.Data, fiveMiB.Data}
	for _, tc := range []struct {
		name     string
		unedited bool
		initial  []ports.ChatContent
		text     string
		retained *[]int
		revision *int64
		add      []ports.ChatContent
		wantData []string
		wantErr  error
	}{
		{name: "without edit", unedited: true, text: "original", wantData: []string{"aGVsbG8="}},
		{name: "preserve omitted", text: "updated", wantData: []string{"aGVsbG8="}},
		{name: "preserve explicit", text: "updated", retained: &[]int{0}, revision: &zero, wantData: []string{"aGVsbG8="}},
		{name: "remove", text: "updated", retained: &[]int{}, revision: &zero},
		{name: "replace", text: "updated", retained: &[]int{}, revision: &zero, add: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "bmV3"}}, wantData: []string{"bmV3"}},
		{name: "append", text: "updated", add: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "bmV3"}}, wantData: []string{"aGVsbG8=", "bmV3"}},
		{name: "image only", wantData: []string{"aGVsbG8="}},
		{name: "empty after removal", retained: &[]int{}, revision: &zero, wantErr: chatsvc.ErrQueuedTurnTextRequired},
		{name: "stale", text: "updated", retained: &[]int{}, revision: &one, wantErr: chatsvc.ErrQueuedEditConflict},
		{name: "missing revision", text: "updated", retained: &[]int{}, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "invalid index", text: "updated", retained: &[]int{1}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "duplicate index", text: "updated", retained: &[]int{0, 0}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "negative index", text: "updated", retained: &[]int{-1}, revision: &zero, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "preserve at size limit", text: "updated", initial: atLimit, wantData: atLimitData},
		{name: "append at size limit", text: "updated", initial: atLimit[:2], add: atLimit[2:], wantData: atLimitData},
		{name: "append over size limit", text: "updated", initial: atLimit[:2], add: []ports.ChatContent{overFiveMiB}, wantErr: chatsvc.ErrQueuedContentInvalid},
		{name: "append over per-file limit", text: "updated", add: []ports.ChatContent{overTenMiB}, wantErr: chatsvc.ErrQueuedContentInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, provider := steerHarness(t)
			ctx := context.Background()
			initial := tc.initial
			if initial == nil {
				initial = []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "aGVsbG8="}}
			}
			turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "original", ClientMessageID: "queued-edit",
				Origin: domain.MessageOriginHuman, Content: initial})
			if err != nil {
				t.Fatal(err)
			}
			if !tc.unedited {
				err = h.svc.EditQueuedTurn(ctx, testSession, turn.ID, chatsvc.QueuedMessageEdit{
					Text: tc.text, Content: tc.add, RetainedContent: tc.retained, ExpectedRevision: tc.revision,
				})
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("edit = %v, want %v", err, tc.wantErr)
			}
			if _, err := h.svc.PromoteQueuedTurn(ctx, testSession, turn.ID); err != nil {
				t.Fatal(err)
			}
			calls := provider.steers()
			if len(calls) != 1 {
				t.Fatalf("provider calls = %d", len(calls))
			}
			wantText, wantData := tc.text, tc.wantData
			if tc.wantErr != nil {
				wantText, wantData = "original", nil
				for _, block := range initial {
					wantData = append(wantData, block.Data)
				}
			}
			if calls[0].msg.Text != wantText || len(calls[0].msg.Content) != len(wantData) {
				t.Fatalf("provider got text %q and %d attachments; want %q and %d", calls[0].msg.Text, len(calls[0].msg.Content), wantText, len(wantData))
			}
			for i, data := range wantData {
				if calls[0].msg.Content[i].Data != data {
					t.Fatalf("attachment %d changed", i)
				}
			}
		})
	}
}

func TestQueuedEditRetryAfterCommittedResponseIsLost(t *testing.T) {
	h, provider := steerHarness(t)
	ctx := context.Background()
	originalMessage := ports.ChatUserMessage{
		Text: "original", ClientMessageID: "queue-original", Origin: domain.MessageOriginHuman,
		Content: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "b2xk"}},
	}
	turn, err := h.svc.Send(ctx, testSession, originalMessage)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := h.st.ConversationForSession(ctx, testSession)
	if err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	edit := chatsvc.QueuedMessageEdit{
		ClientMessageID: "queue-edit-receipt", Text: "updated", ExpectedRevision: &zero,
		RetainedContent: &[]int{0},
		Content:         []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "bmV3"}},
	}
	// The first request commits, but the caller never receives its success.
	if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, edit); err != nil {
		t.Fatal(err)
	}
	committed, err := h.st.QueuedTurnMessage(ctx, conversation.ID, turn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if committed.Revision != 1 {
		t.Fatalf("committed revision = %d, want 1", committed.Revision)
	}
	if duplicate, err := h.svc.Send(ctx, testSession, originalMessage); err != nil || duplicate.ID != "" {
		t.Fatalf("retry original send after queue edit = %+v, err = %v", duplicate, err)
	}
	changedMessage := originalMessage
	changedMessage.Text = "another request"
	if _, err := h.svc.Send(ctx, testSession, changedMessage); !errors.Is(err, domain.ErrClientMessageConflict) {
		t.Fatalf("changed original send after queue edit = %v, want conflict", err)
	}
	// The renderer retries the identical request with its original revision.
	if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, edit); err != nil {
		t.Fatalf("retry: %v", err)
	}
	retried, err := h.st.QueuedTurnMessage(ctx, conversation.ID, turn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Revision != committed.Revision || retried.Text != committed.Text || retried.DeliveryContentJSON != committed.DeliveryContentJSON {
		t.Fatalf("retry mutated the committed message: before=%+v after=%+v", committed, retried)
	}
	for _, change := range []struct {
		name   string
		mutate func(*chatsvc.QueuedMessageEdit)
	}{
		{"text", func(e *chatsvc.QueuedMessageEdit) { e.Text = "different" }},
		{"retained attachments", func(e *chatsvc.QueuedMessageEdit) { e.RetainedContent = &[]int{} }},
		{"native bytes", func(e *chatsvc.QueuedMessageEdit) {
			e.Content = []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "eA=="}}
		}},
	} {
		t.Run(change.name, func(t *testing.T) {
			changed := edit
			change.mutate(&changed)
			if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, changed); !errors.Is(err, store.ErrQueuedEditDeliveryConflict) {
				t.Fatalf("changed request with reused key = %v, want conflict", err)
			}
		})
	}
	if _, err := h.svc.PromoteQueuedTurn(ctx, testSession, turn.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, edit); err != nil {
		t.Fatalf("retry after dispatch: %v", err)
	}
	if err := h.svc.Stop(ctx, testSession); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.EditQueuedTurn(ctx, testSession, turn.ID, edit); err != nil {
		t.Fatalf("retry after controller teardown: %v", err)
	}
	calls := provider.steers()
	if len(calls) != 1 || calls[0].msg.Text != "updated" || len(calls[0].msg.Content) != 2 || calls[0].msg.Content[0].Data != "b2xk" || calls[0].msg.Content[1].Data != "bmV3" {
		t.Fatalf("provider must receive the edited text and attachments exactly once: %+v", calls)
	}
}

// With a live controller the append and the drain are serialized: the turn
// that follows a busy one carries every absorbed batch, and a batch that
// arrives after dispatch is refused for the caller to deliver as a new turn.
func TestAbsorbReportBatchWithLiveController(t *testing.T) {
	h, provider := steerHarness(t)
	ctx := context.Background()
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: reportsvc.ReportBatchHeader + "\n\n[done] w1", ClientMessageID: "report-batch:r1",
		Origin: domain.MessageOriginAutomation,
	}); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"r2", "r3"} {
		absorbed, err := h.svc.AbsorbReportBatch(ctx, testSession, reportsvc.ReportBatchHeader+"\n\n[done] "+key, "report-batch:"+key)
		if err != nil || !absorbed {
			t.Fatalf("absorb %s = %v, %v; want true", key, absorbed, err)
		}
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateCompleted})
	want := reportsvc.ReportBatchHeader + "\n\n[done] w1\n\n[done] r2\n\n[done] r3"
	deadline := time.Now().Add(5 * time.Second)
	for {
		texts := provider.sentTexts()
		if len(texts) == 2 {
			if texts[1] != want {
				t.Fatalf("report turn prompt = %q, want %q", texts[1], want)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued report turn never dispatched: %q", texts)
		}
		time.Sleep(10 * time.Millisecond)
	}
	absorbed, err := h.svc.AbsorbReportBatch(ctx, testSession, reportsvc.ReportBatchHeader+"\n\n[done] late", "report-batch:r4")
	if err != nil || absorbed {
		t.Fatalf("absorb after dispatch = %v, %v; want false", absorbed, err)
	}
}

// A stuck report interrupts the running turn before its batch is delivered, and
// the batch is delivered after Interrupt returns but before the turn's
// completion drains the queue. The interrupt cancels turns requested at or
// before its cutoff, so the absorbed turn must be requested after it or it would
// be dropped with the old turn.
func TestAbsorbReportBatchSurvivesEarlierInterrupt(t *testing.T) {
	h, provider := steerHarness(t)
	ctx := context.Background()
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: reportsvc.ReportBatchHeader + "\n\n[done] w1", ClientMessageID: "report-batch:r1",
		Origin: domain.MessageOriginAutomation,
	}); err != nil {
		t.Fatal(err)
	}
	h.advance(time.Second)
	if err := h.svc.Interrupt(ctx, testSession); err != nil {
		t.Fatal(err)
	}
	// The clock has not moved since the interrupt's cutoff, as on a coarse
	// clock: the report must still land strictly after it. Interrupt has
	// returned but the provider's completion is not yet projected.
	if absorbed, err := h.svc.AbsorbReportBatch(ctx, testSession,
		reportsvc.ReportBatchHeader+"\n\n[stuck] w2", "report-batch:r2"); err != nil || !absorbed {
		t.Fatalf("absorb = %v, %v; want true", absorbed, err)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateInterrupted})
	want := reportsvc.ReportBatchHeader + "\n\n[done] w1\n\n[stuck] w2"
	deadline := time.Now().Add(5 * time.Second)
	for {
		texts := provider.sentTexts()
		if len(texts) == 2 {
			if texts[1] != want {
				t.Fatalf("report turn prompt = %q, want %q", texts[1], want)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("absorbed report turn was dropped by the interrupt: %q", texts)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// blockingAbsorbStore pauses an absorb inside the store, after its controller
// lookup and before its append commits.
type blockingAbsorbStore struct {
	chatsvc.Store
	entered chan struct{}
	release chan struct{}
}

func (s *blockingAbsorbStore) AbsorbQueuedReportBatch(
	ctx context.Context, conversationID, batchKey, addition string, now, cancelCutoff time.Time,
) (bool, error) {
	close(s.entered)
	<-s.release
	return s.Store.AbsorbQueuedReportBatch(ctx, conversationID, batchKey, addition, now, cancelCutoff)
}

// A controller that starts while a report is being absorbed must not publish,
// and so must not drain the queued turn, until the append has committed;
// otherwise it would dispatch the text it read before the append and the
// absorbed reports would never reach the agent.
func TestAbsorbReportBatchHoldsControllerPublicationUntilAppendCommits(t *testing.T) {
	st, _ := openProvisioningStore(t, domain.SessionProvisionReady)
	ctx := context.Background()
	now := time.Now().UTC()
	orchestrator, err := st.CreateSession(ctx, domain.SessionRecord{
		ProjectID: testProject, Kind: domain.KindOrchestrator,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		ProvisionState: domain.SessionProvisionProvisioning,
		CreatedAt:      now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	blocking := &blockingAbsorbStore{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
	provider := newFakeConversation()
	next := 0
	svc := chatsvc.New(chatsvc.Options{
		Store: blocking, Sessions: st, Reader: fullSnapshotReader(st),
		Drivers: fakeRegistry{driver: fakeDriver{conv: provider}},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			next++
			return fmt.Sprintf("absorb-publication-%d", next)
		},
	})
	// The first batch is queued before any controller exists.
	if _, err := svc.Send(ctx, orchestrator.ID, ports.ChatUserMessage{
		Text: reportsvc.ReportBatchHeader + "\n\n[done] w1", ClientMessageID: "report-batch:r1",
		Origin: domain.MessageOriginAutomation,
	}); err != nil {
		t.Fatal(err)
	}

	type absorbResult struct {
		absorbed bool
		err      error
	}
	absorbed := make(chan absorbResult, 1)
	go func() {
		ok, err := svc.AbsorbReportBatch(ctx, orchestrator.ID,
			reportsvc.ReportBatchHeader+"\n\n[done] w2", "report-batch:r2")
		absorbed <- absorbResult{ok, err}
	}()
	<-blocking.entered

	started := make(chan error, 1)
	go func() {
		_, err := svc.Start(ctx, chatsvc.StartConfig{
			SessionID: orchestrator.ID, ProjectID: testProject, Harness: domain.HarnessCodex,
			WorkspacePath: t.TempDir(), ProviderConversationID: "thread-1",
		})
		started <- err
	}()
	select {
	case err := <-started:
		t.Fatalf("controller published while a report append was in flight (start err = %v)", err)
	case <-time.After(300 * time.Millisecond):
	}

	close(blocking.release)
	if result := <-absorbed; result.err != nil || !result.absorbed {
		t.Fatalf("absorb = %+v; want absorbed", result)
	}
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), orchestrator.ID) })

	if err := svc.DrainQueued(ctx, orchestrator.ID); err != nil {
		t.Fatal(err)
	}
	want := reportsvc.ReportBatchHeader + "\n\n[done] w1\n\n[done] w2"
	deadline := time.Now().Add(5 * time.Second)
	for {
		texts := provider.sentTexts()
		if len(texts) == 1 && texts[0] == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("provider received %q; want the absorbed report turn %q", texts, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
