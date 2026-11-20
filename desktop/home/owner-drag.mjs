export function createOwnerDragQueue({
  fence,
  valid,
  start,
  move,
  end,
  cancelled,
}) {
  const states = new WeakMap();

  function stateFor(entry) {
    if (!states.has(entry)) states.set(entry, { queue: [] });
    return states.get(entry);
  }

  function drain(entry, state) {
    while (!state.active && state.queue.length) {
      const job = state.queue.shift();
      if (job.run) {
        state.active = job;
        job.cancel = job.run((result) => {
          if (state.active !== job) return;
          try {
            job.finish(result);
          } finally {
            state.active = undefined;
            drain(entry, state);
          }
        });
        return;
      }
      if (!valid(entry, job.fence)) {
        if (state.pointer === job) state.pointer = undefined;
        continue;
      }
      state.active = job;
      job.from = start(entry);
      applyDrag(entry, state, job);
    }
  }

  function applyDrag(entry, state, job) {
    const { origin, from, last, released } = job;
    move(entry, {
      x: from.x + last.x - origin.x,
      y: from.y + last.y - origin.y,
    });
    if (!released) return;
    state.active = undefined;
    end(entry, from);
    drain(entry, state);
  }

  function clear(entry) {
    const state = states.get(entry);
    if (!state) return;
    state.pointer = undefined;
    state.queue = state.queue.filter((job) => job.run);
    if (state.active && !state.active.run) {
      cancelled?.(entry);
      state.active = undefined;
      drain(entry, state);
    }
  }

  function handle(entry, action, point) {
    const state = stateFor(entry);
    if (action === "drag-start") {
      if (state.pointer) return;
      const captured = fence(entry);
      if (!valid(entry, captured)) return;
      const job = { fence: captured, origin: point, last: point };
      state.pointer = job;
      state.queue.push(job);
      drain(entry, state);
      return;
    }
    const job = state.pointer;
    if (!job) return;
    if (!valid(entry, job.fence)) return clear(entry);
    job.last = point;
    if (action === "drag-end") {
      job.released = true;
      state.pointer = undefined;
    }
    if (state.active === job) applyDrag(entry, state, job);
  }

  function body(entry, current, finish, execute) {
    const state = stateFor(entry);
    if (state.pointer && !valid(entry, state.pointer.fence)) clear(entry);
    let finished = false;
    const job = {
      finish(result) {
        if (finished) return;
        finished = true;
        finish(result);
      },
      run(advance) {
        job.advance = advance;
        if (!current())
          return advance({ status: "cancelled", reason: "inactive" });
        try {
          return execute(advance);
        } catch {
          advance({ status: "failed", reason: "position-unconfirmed" });
        }
      },
    };
    state.queue.push(job);
    drain(entry, state);
    return (reason) => {
      if (finished) return;
      const terminal = { status: "cancelled", reason };
      if (state.active === job) {
        job.cancel?.(reason);
        job.advance(terminal);
      } else {
        const index = state.queue.indexOf(job);
        if (index !== -1) state.queue.splice(index, 1);
        job.finish(terminal);
      }
    };
  }

  return {
    handle,
    body,
    clear,
    capturing: (entry) => Boolean(states.get(entry)?.pointer),
  };
}
