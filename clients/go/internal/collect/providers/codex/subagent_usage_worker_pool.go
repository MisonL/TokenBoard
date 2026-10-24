package codex

// Port of codex-subagent-usage-worker-pool.ts: the bounded executor the
// correction runs child-file reads on.
//
// Worker-pool decision (why this is a goroutine pool, not a child process):
// the TS module exists only to move CPU-bound JSONL parsing off the collector's
// main thread — `codex-subagent-usage-worker.mjs` imports the very same
// `readChildLastUsageByDate`/`readChildLastUsageEvents` functions this package
// exports and has no protocol of its own beyond a request/response envelope.
// It is not a cross-process contract with any other component (unlike the
// cursor or cache files, which the TS and Go collectors share on disk), and no
// state crosses the boundary. Go has no main-thread/worker split to escape, so
// spawning Node to run that script would add a runtime dependency and a second
// implementation of the same parse for no behavioral gain. The pool therefore
// runs the identical read functions on a fixed number of goroutines while
// preserving every observable property the TS tests assert:
//
//   - the same worker-count limits (default min(4, availableParallelism), with
//     availableParallelism modelled as runtime.NumCPU(); absolute max 8;
//     `Invalid Codex subagent worker count: expected an integer from 1 to 8`);
//   - FIFO dispatch: the next queued task goes to the first idle worker in
//     worker order, so results arrive in completion order, not enqueue order,
//     exactly like the TS pool;
//   - task-level failure isolation: a read that returns an error rejects only
//     its own task, and the worker picks up the next queued one;
//   - fatal failures: an unexpected worker termination — a panic in the read,
//     which Go cannot let escape a goroutine — fails the whole pool with
//     `Codex subagent usage worker exited unexpectedly with code 1`, rejects
//     every in-flight and queued task with that error, and refuses later work.
//     (The TS suite drives the same path with a worker that exits 0; the exit
//     code itself is the only value that cannot be reproduced, because a Go
//     panic has no exit status. The message shape is identical.)
//   - an oversized warning (more than 4096 UTF-16 units) is fatal the same way
//     `Codex subagent usage worker returned an oversized warning` is in TS;
//   - close rejects in-flight and queued tasks with
//     `Codex subagent usage worker pool closed before completing queued work`
//     (or the fatal error when one was recorded) and waits for the running
//     reads to return. A goroutine cannot be killed the way
//     `worker.terminate()` kills a thread, so close waits rather than
//     abandoning a read that may still be touching the file system.

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
)

const (
	// defaultMaxCodexSubagentWorkers is the TS defaultMaxWorkers.
	defaultMaxCodexSubagentWorkers = 4
	// absoluteMaxCodexSubagentWorkers is the TS absoluteMaxWorkers.
	absoluteMaxCodexSubagentWorkers = 8
	// maxCodexSubagentWorkerWarningLength is the TS warning bound, in UTF-16
	// code units, because that is what JS `.length` counts.
	maxCodexSubagentWorkerWarningLength = 4_096
)

// SubagentReadKind selects which child read a pool task runs.
type SubagentReadKind string

const (
	// SubagentReadByDate is the date-aggregated child read.
	SubagentReadByDate SubagentReadKind = "by-date"
	// SubagentReadEvents is the event-level child read.
	SubagentReadEvents SubagentReadKind = "events"
)

// SubagentWorkerRequest is the request envelope the TS worker protocol
// carries. It is documented here because the goroutine pool runs the same read
// functions in-process; a future process-backed pool must keep this shape.
type SubagentWorkerRequest struct {
	ID        int              `json:"id"`
	Kind      SubagentReadKind `json:"kind"`
	FilePath  string           `json:"filePath"`
	Timestamp string           `json:"timestamp"`
	Timezone  string           `json:"timezone"`
}

// SubagentWorkerResponse is the TS worker's response envelope. Exactly one of
// Warning, Error or Result is set.
type SubagentWorkerResponse struct {
	ID      int                  `json:"id"`
	Warning *string              `json:"warning,omitempty"`
	Result  any                  `json:"result,omitempty"`
	Error   *SubagentWorkerError `json:"error,omitempty"`
}

// SubagentWorkerError is the serialized error shape of the TS protocol.
type SubagentWorkerError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

// SubagentUsageReader is the read surface one pool slot runs.
type SubagentUsageReader interface {
	Read(filePath, timestamp, timezone string, stderr func(string)) ([]DatedUsage, error)
	ReadEvents(filePath, timestamp, timezone string, stderr func(string)) ([]ChildUsageEvent, error)
}

// SubagentUsageWorkerPool runs child reads on a bounded goroutine set.
type SubagentUsageWorkerPool struct {
	Concurrency int

	mu         sync.Mutex
	workers    []*subagentPoolWorker
	queue      []*subagentPoolTask
	nextTaskID int
	closing    bool
	fatalError error
	closed     chan struct{}
	closeOnce  sync.Once
	wg         sync.WaitGroup
}

type subagentPoolWorker struct {
	// pending is the task this worker is running, guarded by the pool mutex.
	pending *subagentPoolTask
	signal  chan *subagentPoolTask
}

type subagentPoolTask struct {
	request SubagentWorkerRequest
	stderr  func(string)
	result  chan subagentPoolResult
	// finished is guarded by the pool mutex and guarantees exactly one send on
	// result: a close or fatal failure may race the worker that is running it.
	finished bool
}

type subagentPoolResult struct {
	value any
	err   error
}

// SubagentWorkerFactory creates the runner for one pool slot. It exists so the
// tests can drive a worker that dies the way a terminated thread would; nil
// uses the in-process reader, which is the production path.
type SubagentWorkerFactory func() SubagentUsageReader

// DefaultCodexSubagentWorkerCount ports defaultCodexSubagentWorkerCount:
// min(4, availableParallelism), at least 1.
func DefaultCodexSubagentWorkerCount() int {
	parallelism := runtime.NumCPU()
	if parallelism < 1 {
		parallelism = 1
	}
	if parallelism > defaultMaxCodexSubagentWorkers {
		return defaultMaxCodexSubagentWorkers
	}
	return parallelism
}

// NormalizeCodexSubagentWorkerCount ports normalizeCodexSubagentWorkerCount.
func NormalizeCodexSubagentWorkerCount(value int) (int, error) {
	if value < 1 || value > absoluteMaxCodexSubagentWorkers {
		return 0, fmt.Errorf(
			"Invalid Codex subagent worker count: expected an integer from 1 to %d",
			absoluteMaxCodexSubagentWorkers)
	}
	return value, nil
}

// NewCodexSubagentUsageWorkerPool creates a pool of workerCount goroutines and
// starts them, mirroring the TS pool's eager `new Worker(...)`.
func NewCodexSubagentUsageWorkerPool(
	workerCount int,
	workerFactory SubagentWorkerFactory,
) (*SubagentUsageWorkerPool, error) {
	concurrency, err := NormalizeCodexSubagentWorkerCount(workerCount)
	if err != nil {
		return nil, err
	}
	if workerFactory == nil {
		workerFactory = func() SubagentUsageReader { return subagentInProcessReader{} }
	}
	pool := &SubagentUsageWorkerPool{
		Concurrency: concurrency,
		nextTaskID:  1,
		closed:      make(chan struct{}),
	}
	pool.workers = make([]*subagentPoolWorker, concurrency)
	for index := range pool.workers {
		worker := &subagentPoolWorker{signal: make(chan *subagentPoolTask, 1)}
		pool.workers[index] = worker
		pool.wg.Add(1)
		go pool.runWorker(worker, workerFactory())
	}
	return pool, nil
}

// Read enqueues a date-aggregated child read.
func (p *SubagentUsageWorkerPool) Read(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	value, err := p.enqueue(SubagentReadByDate, filePath, timestamp, timezone, stderr)
	if err != nil {
		return nil, err
	}
	usages, ok := value.([]DatedUsage)
	if !ok {
		return nil, errors.New("Codex subagent usage worker returned an invalid result")
	}
	return usages, nil
}

// ReadEvents enqueues an event-level child read.
func (p *SubagentUsageWorkerPool) ReadEvents(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	value, err := p.enqueue(SubagentReadEvents, filePath, timestamp, timezone, stderr)
	if err != nil {
		return nil, err
	}
	events, ok := value.([]ChildUsageEvent)
	if !ok {
		return nil, errors.New("Codex subagent usage worker returned an invalid result")
	}
	return events, nil
}

func (p *SubagentUsageWorkerPool) enqueue(
	kind SubagentReadKind,
	filePath, timestamp, timezone string,
	stderr func(string),
) (any, error) {
	p.mu.Lock()
	if p.closing {
		p.mu.Unlock()
		return nil, errors.New("Codex subagent usage worker pool is closed")
	}
	if p.fatalError != nil {
		err := p.fatalError
		p.mu.Unlock()
		return nil, err
	}
	task := &subagentPoolTask{
		request: SubagentWorkerRequest{
			ID:        p.nextTaskID,
			Kind:      kind,
			FilePath:  filePath,
			Timestamp: timestamp,
			Timezone:  timezone,
		},
		stderr: p.wrapStderr(stderr),
		result: make(chan subagentPoolResult, 1),
	}
	p.nextTaskID++
	p.queue = append(p.queue, task)
	p.dispatchLocked()
	p.mu.Unlock()

	result := <-task.result
	return result.value, result.err
}

// wrapStderr enforces the TS pool's warning bound on every line the read
// reports, because an in-process read has no message envelope to measure.
func (p *SubagentUsageWorkerPool) wrapStderr(stderr func(string)) func(string) {
	if stderr == nil {
		return nil
	}
	return func(line string) {
		if !subagentWarningFits(line) {
			p.failPool(errors.New("Codex subagent usage worker returned an oversized warning"))
			return
		}
		stderr(line)
	}
}

// dispatchLocked hands queued tasks to idle workers in worker order.
func (p *SubagentUsageWorkerPool) dispatchLocked() {
	if p.closing || p.fatalError != nil {
		return
	}
	for _, worker := range p.workers {
		if worker.pending != nil {
			continue
		}
		if len(p.queue) == 0 {
			return
		}
		task := p.queue[0]
		p.queue = p.queue[1:]
		worker.pending = task
		// The signal channel has one slot and the worker is idle, so this
		// never blocks while the pool mutex is held.
		worker.signal <- task
	}
}

func (p *SubagentUsageWorkerPool) runWorker(worker *subagentPoolWorker, reader SubagentUsageReader) {
	defer p.wg.Done()
	for {
		select {
		case <-p.closed:
			return
		case task := <-worker.signal:
			if task == nil {
				return
			}
			p.mu.Lock()
			skip := p.closing || task.finished
			p.mu.Unlock()
			if skip {
				continue
			}
			p.executeTask(worker, reader, task)
		}
	}
}

func (p *SubagentUsageWorkerPool) executeTask(
	worker *subagentPoolWorker,
	reader SubagentUsageReader,
	task *subagentPoolTask,
) {
	value, err := runSubagentPoolTask(reader, task)
	if err != nil {
		var exit *subagentWorkerExitError
		if errors.As(err, &exit) {
			p.failPool(err)
			return
		}
	}
	p.completeTask(worker, task, subagentPoolResult{value: value, err: err})
}

// runSubagentPoolTask runs one read and converts a panic into the pool-fatal
// error a dead TS worker produces. A panic escaping a goroutine would kill the
// collector, which is strictly worse than the TS behavior it stands in for.
func runSubagentPoolTask(reader SubagentUsageReader, task *subagentPoolTask) (value any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = &subagentWorkerExitError{code: 1}
		}
	}()
	switch task.request.Kind {
	case SubagentReadByDate:
		usages, readErr := reader.Read(
			task.request.FilePath, task.request.Timestamp, task.request.Timezone, task.stderr)
		if readErr != nil {
			return nil, readErr
		}
		return usages, nil
	case SubagentReadEvents:
		events, readErr := reader.ReadEvents(
			task.request.FilePath, task.request.Timestamp, task.request.Timezone, task.stderr)
		if readErr != nil {
			return nil, readErr
		}
		return events, nil
	}
	return nil, errors.New("Codex subagent usage worker returned an invalid response")
}

// completeTask delivers one result and frees the worker for the next task. A
// task already rejected by close or failPool is delivered once, from there.
func (p *SubagentUsageWorkerPool) completeTask(
	worker *subagentPoolWorker,
	task *subagentPoolTask,
	result subagentPoolResult,
) {
	p.mu.Lock()
	defer p.mu.Unlock()
	worker.pending = nil
	if task.finished {
		return
	}
	task.finished = true
	task.result <- result
	p.dispatchLocked()
}

// subagentWorkerExitError stands in for a worker thread that exited without
// answering. Its message is the TS diagnostic, including the exit code.
type subagentWorkerExitError struct {
	code int
}

func (e *subagentWorkerExitError) Error() string {
	return fmt.Sprintf("Codex subagent usage worker exited unexpectedly with code %d", e.code)
}

// failPool records a fatal error and rejects every in-flight and queued task.
// Later enqueues are rejected with the same error.
func (p *SubagentUsageWorkerPool) failPool(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fatalError != nil {
		return
	}
	p.fatalError = err
	for _, worker := range p.workers {
		if worker.pending == nil {
			continue
		}
		p.rejectTaskLocked(worker.pending, err)
		worker.pending = nil
	}
	for _, task := range p.queue {
		p.rejectTaskLocked(task, err)
	}
	p.queue = nil
}

// Close rejects in-flight and queued work and waits for the workers to stop.
// It is idempotent; every call waits for the same completion.
func (p *SubagentUsageWorkerPool) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closing = true
		err := p.fatalError
		if err == nil {
			err = errors.New("Codex subagent usage worker pool closed before completing queued work")
		}
		for _, worker := range p.workers {
			if worker.pending == nil {
				continue
			}
			p.rejectTaskLocked(worker.pending, err)
			worker.pending = nil
		}
		for _, task := range p.queue {
			p.rejectTaskLocked(task, err)
		}
		p.queue = nil
		p.mu.Unlock()
		close(p.closed)
		p.wg.Wait()
	})
	return nil
}

func (p *SubagentUsageWorkerPool) rejectTaskLocked(task *subagentPoolTask, err error) {
	if task.finished {
		return
	}
	task.finished = true
	task.result <- subagentPoolResult{err: err}
}

// subagentInProcessReader is the production runner: the same functions the TS
// worker script calls.
type subagentInProcessReader struct{}

func (subagentInProcessReader) Read(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	return ReadChildLastUsageByDate(filePath, timestamp, timezone, stderr)
}

func (subagentInProcessReader) ReadEvents(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	return ReadChildLastUsageEvents(filePath, timestamp, timezone, stderr)
}

// subagentWarningFits applies the TS warning bound in UTF-16 code units.
func subagentWarningFits(value string) bool {
	return codexUTF16Length(value) <= maxCodexSubagentWorkerWarningLength
}
