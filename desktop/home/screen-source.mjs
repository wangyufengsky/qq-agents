export function findScreenSource(sources, selected) {
  // Window titles change as users navigate. The OS source ID identifies the window.
  return sources.find(
    ({ id, display_id }) =>
      id === selected.id && display_id === selected.display_id,
  );
}
