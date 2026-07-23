package protocol

import (
	"context"
	"sync"
	"time"
)

// AbortController composes parent cancellation, a fixed deadline, and resettable idle timeout.
type AbortController struct {
	ctx        context.Context
	cancel     context.CancelFunc
	bodyCtx    context.Context
	bodyCancel context.CancelFunc

	mu       sync.Mutex
	deadline *time.Timer
	idle     *time.Timer
	idleTime time.Duration
	idleGen  uint64
	done     bool
}

func NewAbortController(parent context.Context, deadline time.Duration, idleTimeout time.Duration) *AbortController {
	ctx, cancel := context.WithCancel(parent)
	bodyCtx, bodyCancel := context.WithCancel(ctx)
	ac := &AbortController{
		ctx: ctx, cancel: cancel, bodyCtx: bodyCtx, bodyCancel: bodyCancel, idleTime: idleTimeout,
	}
	ac.mu.Lock()
	if deadline > 0 {
		ac.deadline = time.AfterFunc(deadline, ac.Cancel)
	}
	if idleTimeout > 0 {
		ac.scheduleIdleLocked()
	}
	ac.mu.Unlock()
	context.AfterFunc(ctx, ac.Cancel)
	return ac
}

func (ac *AbortController) Context() context.Context { return ac.ctx }

// BodyContext is canceled with the request or independently by CancelBody.
func (ac *AbortController) BodyContext() context.Context { return ac.bodyCtx }

func (ac *AbortController) Cancel() {
	ac.mu.Lock()
	if ac.done {
		ac.mu.Unlock()
		return
	}
	ac.done = true
	if ac.deadline != nil {
		ac.deadline.Stop()
	}
	if ac.idle != nil {
		ac.idle.Stop()
	}
	ac.mu.Unlock()
	ac.cancel()
	ac.bodyCancel()
}

// CancelBody cancels response-body work without canceling the request context.
func (ac *AbortController) CancelBody() { ac.bodyCancel() }

// ResetIdle starts a fresh idle window after observed activity.
func (ac *AbortController) ResetIdle() {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	if ac.done || ac.idleTime <= 0 || ac.ctx.Err() != nil {
		return
	}
	if ac.idle == nil {
		ac.scheduleIdleLocked()
	} else {
		ac.idle.Stop()
		ac.scheduleIdleLocked()
	}
}

func (ac *AbortController) scheduleIdleLocked() {
	ac.idleGen++
	generation := ac.idleGen
	ac.idle = time.AfterFunc(ac.idleTime, func() { ac.idleExpired(generation) })
}

func (ac *AbortController) idleExpired(generation uint64) {
	ac.mu.Lock()
	if ac.done || generation != ac.idleGen {
		ac.mu.Unlock()
		return
	}
	ac.done = true
	if ac.deadline != nil {
		ac.deadline.Stop()
	}
	ac.mu.Unlock()
	ac.cancel()
	ac.bodyCancel()
}
