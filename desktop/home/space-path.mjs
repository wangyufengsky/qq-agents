export const GAP = 12;
const MAX_SEARCH_STEPS = 16384;
export const right = (rect) => rect.x + rect.width;
export const bottom = (rect) => rect.y + rect.height;

const contains = (rect, point) =>
  point.x >= rect.x &&
  point.x <= right(rect) &&
  point.y >= rect.y &&
  point.y <= bottom(rect);

function crossingRegion(first, second, body, vertical) {
  const axis = vertical ? "x" : "y";
  const along = vertical ? "y" : "x";
  const size = vertical ? "width" : "height";
  const length = vertical ? "height" : "width";
  const edge = first[axis] + first[size];
  const farEdge = second[axis] + second[size];
  if (first[axis] > second[axis] || edge < second[axis] || edge > farEdge)
    return;
  const low = Math.max(first[along], second[along]) + GAP;
  const high =
    Math.min(first[along] + first[length], second[along] + second[length]) -
    body[length] -
    GAP;
  if (low > high) return;
  // Overlapping DIP work areas can already meet in the inset display regions.
  // Otherwise bridge only the positions covered by both areas' combined span.
  const from = Math.min(edge - body[size], second[axis]);
  const to = Math.max(edge - body[size], second[axis]);
  return {
    [axis]: from,
    [along]: low,
    [size]: to - from,
    [length]: high - low,
  };
}

export function movementRegions(displays, sourceId, body) {
  const areas = displays.filter(
    ({ workArea }) =>
      workArea.width >= body.width && workArea.height >= body.height,
  );
  const source = areas.find(({ id }) => id === sourceId);
  const ids = new Set();
  const regions = [];
  if (!source) return { ids, regions };

  // Work in top-left coordinates. Each crossing region covers positions where
  // the entire window fits in the two work areas with clearance along the join.
  const reachable = [source];
  const connections = new Set();
  ids.add(sourceId);
  for (const display of reachable) {
    const area = display.workArea;
    regions.push({
      ...area,
      width: area.width - body.width,
      height: area.height - body.height,
    });
    for (const neighbor of areas) {
      if (display === neighbor) continue;
      const key =
        display.id < neighbor.id
          ? `${display.id}:${neighbor.id}`
          : `${neighbor.id}:${display.id}`;
      if (connections.has(key)) continue;
      connections.add(key);
      const other = neighbor.workArea;
      const crossings = [
        crossingRegion(area, other, body, true) ??
          crossingRegion(other, area, body, true),
        crossingRegion(area, other, body, false) ??
          crossingRegion(other, area, body, false),
      ].filter(Boolean);
      const fullyOverlapping =
        Math.min(right(area), right(other)) - Math.max(area.x, other.x) >=
          body.width + GAP * 2 &&
        Math.min(bottom(area), bottom(other)) - Math.max(area.y, other.y) >=
          body.height + GAP * 2;
      if (!crossings.length && !fullyOverlapping) continue;
      regions.push(...crossings);
      if (!ids.has(neighbor.id)) {
        ids.add(neighbor.id);
        reachable.push(neighbor);
      }
    }
  }
  return { ids, regions };
}

function intersection(start, end, region) {
  let low = 0;
  let high = 1;
  for (const [axis, limit] of [
    ["x", right(region)],
    ["y", bottom(region)],
  ]) {
    const offset = end[axis] - start[axis];
    if (offset === 0) {
      if (start[axis] < region[axis] || start[axis] > limit) return;
      continue;
    }
    const a = (region[axis] - start[axis]) / offset;
    const b = (limit - start[axis]) / offset;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
    if (low > high) return;
  }
  return [low, high];
}

export function withinRegions(start, end, regions) {
  if (
    regions.some((region) => contains(region, start) && contains(region, end))
  )
    return true;
  // Both endpoints can be visible while the swept window crosses a gap.
  const intervals = regions
    .map((region) => intersection(start, end, region))
    .filter(Boolean)
    .sort(([a], [b]) => a - b);
  let covered = 0;
  for (const [low, high] of intervals) {
    if (low > covered) return false;
    covered = Math.max(covered, high);
    if (covered === 1) return true;
  }
  return false;
}

function addRoute(queue, route) {
  let index = queue.length;
  queue.push(route);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (queue[parent].estimate <= route.estimate) break;
    queue[index] = queue[parent];
    index = parent;
  }
  queue[index] = route;
}

function nextRoute(queue) {
  const first = queue[0];
  const last = queue.pop();
  if (!queue.length) return first;
  let index = 0;
  while (index * 2 + 1 < queue.length) {
    let child = index * 2 + 1;
    if (queue[child + 1]?.estimate < queue[child].estimate) child++;
    if (last.estimate <= queue[child].estimate) break;
    queue[index] = queue[child];
    index = child;
  }
  queue[index] = last;
  return first;
}

export function findCrossDisplayPath(start, end, regions, obstacles, clear) {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if ((!dx || !dy || dx === dy) && clear(start, end)) return [end];
  if (dx && dy) {
    for (const turn of [
      { x: start.x, y: end.y },
      { x: end.x, y: start.y },
    ]) {
      if (clear(start, turn) && clear(turn, end)) return [turn, end];
    }
  }

  // Paths can turn at region and obstacle edges. Search this coordinate grid
  // on demand so large monitors don't increase the number of search points.
  const rects = [...regions, ...obstacles];
  const xs = [
    ...new Set([start.x, end.x, ...rects.flatMap((r) => [r.x, right(r)])]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([start.y, end.y, ...rects.flatMap((r) => [r.y, bottom(r)])]),
  ].sort((a, b) => a - b);
  const startX = xs.indexOf(start.x);
  const startY = ys.indexOf(start.y);
  const endX = xs.indexOf(end.x);
  const endY = ys.indexOf(end.y);
  const heuristic = (x, y) => Math.abs(x - end.x) + Math.abs(y - end.y);
  const key = (i, j) => j * xs.length + i;
  const queue = [];
  const best = new Map([[key(startX, startY), 0]]);
  addRoute(queue, {
    i: startX,
    j: startY,
    length: 0,
    estimate: heuristic(start.x, start.y),
  });
  // Refuse excessively complex layouts before the synchronous desktop loop stalls.
  for (let steps = 0; queue.length && steps < MAX_SEARCH_STEPS; steps++) {
    const route = nextRoute(queue);
    const { i, j, length } = route;
    if (length !== best.get(key(i, j))) continue;
    if (i === endX && j === endY) {
      const path = [];
      let next;
      for (let leg = route; leg.previous; leg = leg.previous) {
        if (!next || (leg.i === leg.previous.i) !== (leg.i === next.i))
          path.push({ x: xs[leg.i], y: ys[leg.j] });
        next = leg;
      }
      return path.reverse();
    }
    const current = { x: xs[i], y: ys[j] };
    for (const [x, y] of [
      [i - 1, j],
      [i + 1, j],
      [i, j - 1],
      [i, j + 1],
    ]) {
      if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
      const point = { x: xs[x], y: ys[y] };
      const distance =
        length + Math.abs(point.x - current.x) + Math.abs(point.y - current.y);
      const index = key(x, y);
      if (distance >= (best.get(index) ?? Infinity) || !clear(current, point))
        continue;
      best.set(index, distance);
      addRoute(queue, {
        i: x,
        j: y,
        length: distance,
        estimate: distance + heuristic(point.x, point.y),
        previous: route,
      });
    }
  }
}
