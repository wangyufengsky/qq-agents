function sameScreenSource(source, selected) {
  // Window titles change as users navigate. The OS source ID identifies the window.
  return source.id === selected.id && source.display_id === selected.display_id;
}

export function findScreenSource(sources, selected) {
  return sources.find((source) => sameScreenSource(source, selected));
}

function externalWindowId({ id }, ownIds) {
  // Electron 45 uses the CGWindowID or HWND in the first numeric field.
  // The second field flags sources owned by this Electron process.
  const match = /^window:([1-9][0-9]{0,19}):0$/.exec(id);
  return match && !ownIds.has(match[1]) ? `w-${match[1]}` : undefined;
}

function ownWindowIds(sources) {
  return new Set(sources.map((id) => /^window:([1-9][0-9]*):/.exec(id)?.[1]));
}

export function observationSources(sources, windows, ownSources, ownPid) {
  const ownIds = ownWindowIds(ownSources);
  const sourceIds = new Set();
  const ambiguous = new Set();
  for (const { id } of sources) {
    if (sourceIds.has(id)) ambiguous.add(id);
    sourceIds.add(id);
  }
  const byId = new Map(windows.map((window) => [window.id, window]));
  return sources.flatMap((source) => {
    const id = externalWindowId(source, ownIds);
    if (!id || ambiguous.has(source.id)) return [];
    const identity = byId.get(id);
    return identity?.state === "ready" && identity.pid !== ownPid
      ? [{ ...source, identity }]
      : [];
  });
}

export function observationTarget(
  sources,
  windows,
  selected,
  ownSources,
  ownPid,
) {
  const { identity } = selected;
  const id = externalWindowId(selected, ownWindowIds(ownSources));
  const window = windows.find((entry) => entry.id === id);
  if (
    !window ||
    window.id !== identity.id ||
    window.pid === ownPid ||
    window.pid !== identity.pid ||
    window.app !== identity.app ||
    window.processInstance !== identity.processInstance
  )
    return { state: "unavailable" };
  if (window.state !== "ready") return { state: window.state };
  const matches = sources.filter(({ id }) => id === selected.id);
  return matches.length === 1 && sameScreenSource(matches[0], selected)
    ? { state: "ready", source: matches[0] }
    : { state: "unavailable" };
}

export async function readObservationFrame(probe, read, current) {
  const before = await probe();
  if (!current()) return {};
  if (before.state !== "ready") return { status: before.state };
  const frame = await read(before.source);
  if (!current()) return {};
  const after = await probe();
  if (!current()) return {};
  if (after.state !== "ready") return { status: after.state };
  if (frame?.permission) return { status: "permission" };
  return frame?.data ? { data: frame.data } : { status: "unavailable" };
}
