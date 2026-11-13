import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bodyDestination } from "./body-client.mjs";
import { clampToWorkArea } from "./window-placement.mjs";

const GAP = 12;
export const MAX_EXCLUSIONS = 24;
const MAX_DISPLAYS = 32;

const right = (rect) => rect.x + rect.width;
const bottom = (rect) => rect.y + rect.height;
const pointOf = ({ x, y }) => ({ x, y });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fits = (rect, area) =>
  rect.x >= area.x &&
  rect.y >= area.y &&
  right(rect) <= right(area) &&
  bottom(rect) <= bottom(area);
const overlaps = (a, b) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
const sameBounds = (a, b) =>
  a?.x === b?.x &&
  a?.y === b?.y &&
  a?.width === b?.width &&
  a?.height === b?.height;

export function displayFingerprint(display) {
  // Electron's invalid or synthetic IDs do not identify a physical display.
  if (!Number.isSafeInteger(display?.id) || [-1, -10].includes(display.id))
    return;
  return createHash("sha256")
    .update(JSON.stringify([display.id, display.label, display.internal]))
    .digest("hex");
}

function validRelativeRect(rect) {
  return (
    rect &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    right(rect) <= 1.000000001 &&
    bottom(rect) <= 1.000000001
  );
}

function exclusionBounds({ workArea }, zones) {
  return zones.map((zone) => {
    const x = workArea.x + Math.floor(zone.x * workArea.width);
    const y = workArea.y + Math.floor(zone.y * workArea.height);
    return {
      x,
      y,
      width:
        Math.min(
          right(workArea),
          workArea.x + Math.ceil(right(zone) * workArea.width),
        ) - x,
      height:
        Math.min(
          bottom(workArea),
          workArea.y + Math.ceil(bottom(zone) * workArea.height),
        ) - y,
    };
  });
}

export class DesktopExclusionStore {
  constructor(path) {
    this.path = path;
    this.entries = [];
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(saved)) {
        this.entries = saved
          .filter(
            (entry) =>
              typeof entry?.fingerprint === "string" &&
              /^[0-9a-f]{64}$/.test(entry.fingerprint) &&
              Array.isArray(entry.zones) &&
              entry.zones.length <= MAX_EXCLUSIONS &&
              entry.zones.every(validRelativeRect),
          )
          .slice(0, MAX_DISPLAYS);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }

  list() {
    return this.entries;
  }

  save(display, zones) {
    const fingerprint = displayFingerprint(display);
    if (
      !fingerprint ||
      !Array.isArray(zones) ||
      zones.length > MAX_EXCLUSIONS ||
      !zones.every(validRelativeRect)
    )
      return false;
    const next = this.entries.filter(
      (entry) => entry.fingerprint !== fingerprint,
    );
    if (zones.length)
      next.push({
        fingerprint,
        zones: zones.map(({ x, y, width, height }) => ({
          x,
          y,
          width,
          height,
        })),
      });
    if (next.length > MAX_DISPLAYS) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = this.path + ".next";
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.entries = next;
    return true;
  }
}

function occupiedRange(rect, body, area) {
  // Expanding obstacles lets a sweep of the window's top left account for its entire size.
  const range = {
    x: rect.x - body.width - GAP,
    y: rect.y - body.height - GAP,
    width: rect.width + body.width + GAP * 2,
    height: rect.height + body.height + GAP * 2,
  };
  range.exits = [
    range.x >= area.x,
    right(range) <= right(area) - body.width,
    range.y >= area.y,
    bottom(range) <= bottom(area) - body.height,
  ];
  return range;
}

function depth(point, rect) {
  return Math.min(
    point.x - rect.x,
    right(rect) - point.x,
    point.y - rect.y,
    bottom(rect) - point.y,
  );
}

function clears(start, end, obstacle) {
  if (depth(start, obstacle) > 0) {
    // A manually positioned or arriving sprite can leave its existing overlap.
    if (start.x === end.x && start.y === end.y) return true;
    const distances = [
      start.x - obstacle.x,
      right(obstacle) - start.x,
      start.y - obstacle.y,
      bottom(obstacle) - start.y,
    ].map((length, index) => (obstacle.exits[index] ? length : Infinity));
    const nearest = Math.min(...distances);
    return (
      Number.isFinite(nearest) &&
      ((distances[0] === nearest && end.x < start.x) ||
        (distances[1] === nearest && end.x > start.x) ||
        (distances[2] === nearest && end.y < start.y) ||
        (distances[3] === nearest && end.y > start.y))
    );
  }
  let entry = 0;
  let exit = 1;
  for (const axis of ["x", "y"]) {
    const min = obstacle[axis];
    const max = min + obstacle[axis === "x" ? "width" : "height"];
    const step = end[axis] - start[axis];
    if (!step) {
      if (start[axis] <= min || start[axis] >= max) return true;
      continue;
    }
    const low = (min - start[axis]) / step;
    const high = (max - start[axis]) / step;
    entry = Math.max(entry, Math.min(low, high));
    exit = Math.min(exit, Math.max(low, high));
    if (entry >= exit) return true;
  }
  return false;
}

function nearbySeat(seat, bounds, area, obstacles) {
  // Prefer the saved seat. When occupied, nearby edges and their intersections
  // provide the closest clear point even when several obstacles overlap.
  const xs = new Set([seat.x]);
  const ys = new Set([seat.y]);
  for (const rect of obstacles) {
    for (const x of [rect.x, right(rect)])
      if (x >= area.x && x + bounds.width <= right(area)) xs.add(x);
    for (const y of [rect.y, bottom(rect)])
      if (y >= area.y && y + bounds.height <= bottom(area)) ys.add(y);
  }
  return [...xs]
    .flatMap((x) => [...ys].map((y) => ({ x, y })))
    .filter((point) => obstacles.every((rect) => depth(point, rect) <= 0))
    .sort((a, b) => distance(seat, a) - distance(seat, b))
    .slice(0, 8);
}

function findPath(start, end, bounds, area, obstacles) {
  const clear = (a, b) => obstacles.every((rect) => clears(a, b, rect));
  if (clear(start, end)) return [end];

  // A small visibility graph of obstacle corners bounds the route search.
  const candidates = new Map();
  for (const rect of obstacles) {
    for (const x of [rect.x - 1, right(rect) + 1]) {
      for (const y of [rect.y - 1, bottom(rect) + 1]) {
        const point = clampToWorkArea(
          { x, y },
          bounds.width,
          bounds.height,
          area,
        );
        if (obstacles.every((other) => depth(point, other) <= 0))
          candidates.set(point.x + ":" + point.y, point);
      }
    }
  }
  candidates.delete(start.x + ":" + start.y);
  candidates.delete(end.x + ":" + end.y);
  const waypoints = [end, ...candidates.values()];
  let routes = new Map([[start, { path: [], length: 0 }]]);
  const best = new Map();
  for (let leg = 0; leg < 4 && routes.size; leg++) {
    const next = new Map();
    for (const [point, route] of routes) {
      for (const waypoint of waypoints) {
        const length = route.length + distance(point, waypoint);
        if (
          point === waypoint ||
          length >= (best.get(waypoint)?.length ?? Infinity) ||
          !clear(point, waypoint)
        )
          continue;
        const candidate = { path: [...route.path, waypoint], length };
        best.set(waypoint, candidate);
        if (waypoint !== end) next.set(waypoint, candidate);
      }
    }
    routes = next;
  }
  return best.get(end)?.path;
}

function sidePoints(anchor, bounds, area) {
  const { width, height } = bounds;
  const middle = clampToWorkArea(
    {
      x: Math.round(anchor.x + (anchor.width - width) / 2),
      y: Math.round(anchor.y + (anchor.height - height) / 2),
    },
    width,
    height,
    area,
  );
  return [
    { x: anchor.x - width - GAP, y: middle.y },
    { x: right(anchor) + GAP, y: middle.y },
    { x: middle.x, y: anchor.y - height - GAP },
    { x: middle.x, y: bottom(anchor) + GAP },
  ].sort((a, b) => distance(bounds, a) - distance(bounds, b));
}

export class DesktopSpace {
  layoutVersion = 1;
  #signature;
  #displayRefs = new Map();
  #residentRefs = new WeakMap();
  #reservations = new Map();

  constructor({ displays, displayAt, door, residents, seat, zones }) {
    Object.assign(this, { displays, displayAt, door, residents, seat, zones });
  }

  invalidate() {
    this.layoutVersion++;
    this.#signature = undefined;
  }

  #context(agentId) {
    const displays = this.displays();
    this.#displayRefs = new Map(
      displays.map(({ id }) => [id, this.#displayRefs.get(id) ?? randomUUID()]),
    );
    const door = this.door();
    const residents = this.residents().map((resident) => {
      if (!this.#residentRefs.has(resident.visit))
        this.#residentRefs.set(resident.visit, randomUUID());
      return {
        ...resident,
        ref: this.#residentRefs.get(resident.visit),
        displayId: this.displayAt(resident.bounds).id,
      };
    });
    const signature = JSON.stringify([
      displays
        .map(({ id, workArea, scaleFactor }) =>
          JSON.stringify([id, workArea, scaleFactor]),
        )
        .sort(),
      residents.map(({ ref, displayId }) => ref + ":" + displayId).sort(),
      door,
    ]);
    if (this.#signature !== undefined && this.#signature !== signature)
      this.layoutVersion++;
    this.#signature = signature;
    const self = residents.find(({ id }) => id === agentId);
    if (!self) return;
    const display = displays.find(({ id }) => id === self.displayId);
    if (!display) return;
    return {
      self,
      display,
      displayRef: this.#displayRefs.get(display.id),
      door: door && this.displayAt(door).id === display.id ? door : undefined,
      doorObstacle: door,
      obstacles: residents.filter(({ id }) => id !== agentId),
    };
  }

  snapshot(agentId) {
    const context = this.#context(agentId);
    if (!context) return;
    const { self, display, displayRef, door, obstacles } = context;
    return {
      layoutVersion: this.layoutVersion,
      sampledAt: Date.now(),
      displays: [
        {
          ref: displayRef,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
        },
      ],
      ...(door && { door: { displayRef, bounds: door } }),
      self: {
        displayRef,
        bounds: self.bounds,
        facing: self.facing ?? "right",
        pose: self.pose ?? "stand",
        ...(self.action && { action: self.action }),
      },
      residents: obstacles
        .filter(({ displayId }) => displayId === display.id)
        .slice(0, 24)
        .map(({ ref, bounds, name }) => ({
          ref,
          displayRef,
          bounds,
          ...(typeof name === "string" && { name: name.slice(0, 80) }),
        })),
    };
  }

  #obstacles({ self, display, obstacles, doorObstacle }) {
    const bounds = self.bounds;
    const key = displayFingerprint(display);
    const zones =
      this.zones().find(({ fingerprint }) => fingerprint === key)?.zones ?? [];
    return [
      ...obstacles.map((resident) => resident.bounds),
      ...(doorObstacle ? [doorObstacle] : []),
      ...exclusionBounds(display, zones),
      ...[...this.#reservations]
        .filter(
          ([id, plan]) =>
            id !== self.id && plan.layoutVersion === this.layoutVersion,
        )
        .map(([, plan]) => plan.bounds),
    ]
      .filter((rect) =>
        overlaps(
          {
            x: display.workArea.x - GAP,
            y: display.workArea.y - GAP,
            width: display.workArea.width + GAP * 2,
            height: display.workArea.height + GAP * 2,
          },
          rect,
        ),
      )
      .map((rect) => occupiedRange(rect, bounds, display.workArea));
  }

  plan(agentId, action, { replan } = {}) {
    const { target, layoutVersion } = action;
    const context = this.#context(agentId);
    if (!context) return { reason: "target-unavailable" };
    if (replan && this.#reservations.get(agentId) !== replan)
      return { reason: "stale-layout" };
    if (
      (typeof target === "object" && layoutVersion !== this.layoutVersion) ||
      (replan && replan.layoutVersion !== this.layoutVersion)
    )
      return { reason: "stale-layout" };
    replan?.release();
    const { self, display, displayRef, door, obstacles } = context;
    const bounds = self.bounds;
    const area = display.workArea;
    if (!fits(bounds, area)) return { reason: "target-unavailable" };
    const legacy = () =>
      bodyDestination({
        door,
        seat: this.seat(agentId),
        display,
        displayAt: this.displayAt,
        bounds,
        target,
        clamp: clampToWorkArea,
      });

    const occupied = this.#obstacles(context);
    let points;
    let anchor;
    if (target === "door" && door) {
      anchor = door;
      points = [legacy(), ...sidePoints(door, bounds, area)];
    } else if (target === "seat") {
      points = [legacy()];
    } else if (target?.type === "near-resident") {
      anchor = obstacles.find(
        ({ ref, displayId }) =>
          ref === target.residentRef && displayId === display.id,
      )?.bounds;
      if (anchor) points = sidePoints(anchor, bounds, area);
    } else if (target?.displayRef === displayRef) {
      if (
        target.type === "point" &&
        [target.x, target.y].every(Number.isSafeInteger)
      ) {
        points = [pointOf(target)];
      } else if (
        target.type === "corner" &&
        ["nw", "ne", "sw", "se"].includes(target.corner)
      ) {
        points = [
          {
            x: target.corner.endsWith("w")
              ? area.x
              : right(area) - bounds.width,
            y: target.corner.startsWith("n")
              ? area.y
              : bottom(area) - bounds.height,
          },
        ];
      }
    }

    const candidates = points?.filter(
      (point) => point && fits({ ...bounds, ...point }, area),
    );
    if (!candidates?.length) return { reason: "target-unavailable" };
    const destinations =
      target === "seat"
        ? nearbySeat(candidates[0], bounds, area, occupied)
        : candidates;
    for (const point of destinations) {
      if (occupied.some((rect) => depth(point, rect) > 0)) continue;
      const path = findPath(pointOf(bounds), point, bounds, area, occupied);
      if (!path) continue;
      const plan = {
        path,
        area,
        anchor,
        target,
        bounds: { ...bounds, ...point },
        destination: { displayRef, ...point },
        layoutVersion: this.layoutVersion,
        release: () => {
          if (this.#reservations.get(agentId) === plan)
            this.#reservations.delete(agentId);
        },
      };
      this.#reservations.set(agentId, plan);
      return plan;
    }
    return { reason: "target-blocked" };
  }

  canStep(agentId, point, plan) {
    const context = this.#context(agentId);
    if (
      !context ||
      this.#reservations.get(agentId) !== plan ||
      this.layoutVersion !== plan.layoutVersion ||
      context.displayRef !== plan.destination.displayRef ||
      !fits({ ...context.self.bounds, ...point }, context.display.workArea)
    )
      return false;

    if (plan.target === "door" && !sameBounds(plan.anchor, context.door))
      return false;
    if (
      plan.target?.type === "near-resident" &&
      !sameBounds(
        plan.anchor,
        context.obstacles.find(({ ref }) => ref === plan.target.residentRef)
          ?.bounds,
      )
    )
      return false;

    const occupied = this.#obstacles(context);
    return occupied.every(
      (rect) =>
        depth(plan.destination, rect) <= 0 &&
        clears(context.self.bounds, point, rect),
    );
  }
}
