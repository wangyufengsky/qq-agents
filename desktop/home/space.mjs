import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bodyDestination } from "./body-client.mjs";
import { clampToWorkArea } from "./window-placement.mjs";
import {
  GAP,
  right,
  bottom,
  movementRegions,
  withinRegions,
  findCrossDisplayPath,
} from "./space-path.mjs";

export const MAX_EXCLUSIONS = 24;
const MAX_DISPLAYS = 32;

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
const validBounds = (bounds) =>
  bounds &&
  [bounds.x, bounds.y, bounds.width, bounds.height].every(
    Number.isSafeInteger,
  ) &&
  bounds.width > 0 &&
  bounds.height > 0;

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

function occupiedRange(rect, body) {
  // Expanding obstacles lets a sweep of the window's top left account for its entire size.
  return {
    x: rect.x - body.width - GAP,
    y: rect.y - body.height - GAP,
    width: rect.width + body.width + GAP * 2,
    height: rect.height + body.height + GAP * 2,
  };
}

function depth(point, rect) {
  return Math.min(
    point.x - rect.x,
    right(rect) - point.x,
    point.y - rect.y,
    bottom(rect) - point.y,
  );
}

function clears(start, end, obstacle, regions) {
  if (depth(start, obstacle) > 0) {
    // A manually positioned or arriving sprite can leave its existing overlap.
    if (start.x === end.x && start.y === end.y) return true;
    const exits = [
      { x: obstacle.x, y: start.y },
      { x: right(obstacle), y: start.y },
      { x: start.x, y: obstacle.y },
      { x: start.x, y: bottom(obstacle) },
    ].filter((point) => withinRegions(start, point, regions));
    const nearest = Math.min(...exits.map((point) => distance(start, point)));
    return exits.some(
      (point) =>
        distance(start, point) === nearest &&
        (point.x - start.x) * (end.x - start.x) +
          (point.y - start.y) * (end.y - start.y) >
          0,
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

function findPath(start, end, bounds, area, obstacles, clear) {
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

function sidePoints(anchor, bounds, area, gap = GAP) {
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
    { x: anchor.x - width - gap, y: middle.y },
    { x: right(anchor) + gap, y: middle.y },
    { x: middle.x, y: anchor.y - height - gap },
    { x: middle.x, y: bottom(anchor) + gap },
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
    const zones = this.zones();
    const residents = this.residents().map((resident) => {
      if (!this.#residentRefs.has(resident.visit))
        this.#residentRefs.set(resident.visit, randomUUID());
      return {
        ...resident,
        ref: this.#residentRefs.get(resident.visit),
        displayId: displays.length
          ? this.displayAt(resident.bounds).id
          : undefined,
      };
    });
    const signature = JSON.stringify([
      displays
        .map(
          ({ id, bounds, workArea, scaleFactor, rotation, label, internal }) =>
            JSON.stringify([
              id,
              bounds,
              workArea,
              scaleFactor,
              rotation,
              label,
              internal,
            ]),
        )
        .sort(),
      residents.map(({ ref }) => ref).sort(),
      door,
      zones,
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
      displays,
      door,
      zones,
      doorDisplayId: door && this.displayAt(door).id,
      obstacles: residents.filter(({ id }) => id !== agentId),
    };
  }

  #advertised({ display, displays }, crossDisplay) {
    if (!crossDisplay) return [display];
    return [
      display,
      ...displays
        .filter(({ id }) => id !== display.id)
        .sort((a, b) => a.id - b.id),
    ].slice(0, MAX_DISPLAYS);
  }

  snapshot(agentId, { crossDisplay = true } = {}) {
    const context = this.#context(agentId);
    if (!context) return;
    const { self, display, door, doorDisplayId, obstacles } = context;
    const displays = this.#advertised(context, crossDisplay);
    const ids = new Set(displays.map(({ id }) => id));
    const action = self.action && {
      kind: self.action.kind,
      state: self.action.state,
      ...(displays.some(
        ({ id }) =>
          this.#displayRefs.get(id) === self.action.destination?.displayRef,
      ) && { destination: self.action.destination }),
    };
    return {
      layoutVersion: this.layoutVersion,
      sampledAt: Date.now(),
      displays: displays.map(({ id, workArea, scaleFactor }) => ({
        ref: this.#displayRefs.get(id),
        workArea,
        scaleFactor,
      })),
      ...(ids.has(doorDisplayId) && {
        door: {
          displayRef: this.#displayRefs.get(doorDisplayId),
          bounds: door,
        },
      }),
      self: {
        displayRef: this.#displayRefs.get(display.id),
        bounds: self.bounds,
        facing: self.facing ?? "right",
        pose: self.pose ?? "stand",
        ...(action && { action }),
      },
      residents: obstacles
        .filter(
          ({ displayId, privatePosition }) =>
            !privatePosition && ids.has(displayId),
        )
        .slice(0, 24)
        .map(({ ref, bounds, name, displayId }) => ({
          ref,
          displayRef: this.#displayRefs.get(displayId),
          bounds,
          ...(typeof name === "string" && { name: name.slice(0, 80) }),
        })),
    };
  }

  #obstacles(
    { self, display, displays, obstacles, door, zones },
    crossDisplay,
    regions,
    localAnchor,
  ) {
    return [
      ...obstacles.map((resident) => resident.bounds),
      ...(door ? [door] : []),
      ...(localAnchor ? [localAnchor] : []),
      ...(crossDisplay ? displays : [display]).flatMap((display) => {
        const key = displayFingerprint(display);
        const exclusions =
          zones.find(({ fingerprint }) => fingerprint === key)?.zones ?? [];
        return exclusionBounds(display, exclusions);
      }),
      ...[...this.#reservations]
        .filter(
          ([id, plan]) =>
            id !== self.id && plan.layoutVersion === this.layoutVersion,
        )
        .map(([, plan]) => plan.bounds),
    ]
      .map((rect) => occupiedRange(rect, self.bounds))
      .filter((rect) => regions.some((region) => overlaps(rect, region)));
  }

  plan(agentId, action, { crossDisplay = true, replan } = {}) {
    const { target, layoutVersion } = action;
    const local = target?.type === "window" || target?.type === "pointer";
    const context = this.#context(agentId);
    if (!context) return { reason: "target-unavailable" };
    if (
      (typeof target === "object" &&
        !local &&
        layoutVersion !== this.layoutVersion) ||
      (replan &&
        (this.#reservations.get(agentId) !== replan ||
          replan.layoutVersion !== this.layoutVersion ||
          replan.crossDisplay !== crossDisplay))
    )
      return { reason: "stale-layout" };
    replan?.release();
    const {
      self,
      display: source,
      displays,
      door,
      doorDisplayId,
      obstacles,
    } = context;
    const bounds = self.bounds;
    const start = pointOf(bounds);
    const seat = target === "seat" ? this.seat(agentId) : undefined;
    const resident =
      target?.type === "near-resident"
        ? obstacles.find(
            ({ ref, privatePosition }) =>
              !privatePosition && ref === target.residentRef,
          )
        : undefined;
    const localBounds = local && target.bounds;
    if (local && !validBounds(localBounds))
      return { reason: "target-unavailable" };
    const anchor = local
      ? localBounds
      : target === "door"
        ? door
        : resident?.bounds;
    const available = crossDisplay ? displays : [source];
    const targetId = local
      ? this.displayAt(localBounds).id
      : target === "door"
        ? doorDisplayId
        : seat
          ? this.displayAt({ ...bounds, ...seat }).id
          : resident
            ? resident.displayId
            : available.find(
                ({ id }) => this.#displayRefs.get(id) === target?.displayRef,
              )?.id;
    const display = available.find(({ id }) => id === targetId);
    if (!display)
      return { reason: local ? "target-unreachable" : "target-unavailable" };
    if (local && !overlaps(localBounds, display.bounds ?? display.workArea))
      return { reason: "target-unavailable" };
    const displayRef = this.#displayRefs.get(display.id);
    const area = display.workArea;
    const legacy = () =>
      bodyDestination({
        door,
        seat,
        display,
        displayAt: this.displayAt,
        bounds,
        target,
        clamp: clampToWorkArea,
      });

    let points;
    if (target === "door" && door) {
      points = [legacy(), ...sidePoints(door, bounds, area)];
    } else if (target === "seat" && seat) {
      points = [legacy()];
    } else if (resident || local) {
      points = sidePoints(
        anchor,
        bounds,
        area,
        target?.type === "pointer" ? 48 : GAP,
      );
    } else if (
      target?.type === "point" &&
      [target.x, target.y].every(Number.isSafeInteger)
    ) {
      points = [pointOf(target)];
    } else if (
      target?.type === "corner" &&
      ["nw", "ne", "sw", "se"].includes(target.corner)
    ) {
      points = [
        {
          x: target.corner.endsWith("w") ? area.x : right(area) - bounds.width,
          y: target.corner.startsWith("n")
            ? area.y
            : bottom(area) - bounds.height,
        },
      ];
    }

    const candidates = points?.filter(
      (point) => point && fits({ ...bounds, ...point }, area),
    );
    if (!candidates?.length)
      return { reason: local ? "target-blocked" : "target-unavailable" };
    const { ids, regions } = movementRegions(available, source.id, bounds);
    if (!ids.has(display.id)) return { reason: "target-unreachable" };
    if (!withinRegions(start, start, regions))
      return { reason: "target-unavailable" };
    const occupied = this.#obstacles(
      context,
      crossDisplay,
      regions,
      localBounds,
    );
    const clear = (a, b) =>
      withinRegions(a, b, regions) &&
      occupied.every((rect) => clears(a, b, rect, regions));
    const destinations =
      target === "seat"
        ? nearbySeat(candidates[0], bounds, area, occupied)
        : candidates;
    const sameDisplay = source.id === display.id && fits(bounds, area);
    for (const point of destinations) {
      if (occupied.some((rect) => depth(point, rect) > 0)) continue;
      const path =
        (sameDisplay
          ? findPath(start, point, bounds, area, occupied, clear)
          : undefined) ??
        (crossDisplay
          ? findCrossDisplayPath(start, point, regions, occupied, clear)
          : undefined);
      if (!path) continue;
      const plan = {
        path,
        regions,
        anchor,
        localBounds,
        target,
        crossDisplay,
        bounds: { ...bounds, ...point },
        displayId: display.id,
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

  canStep(agentId, point, plan, from) {
    const context = this.#context(agentId);
    if (!context) return false;
    const bounds = context.self.bounds;
    const start = from ?? bounds;
    if (
      this.#reservations.get(agentId) !== plan ||
      this.layoutVersion !== plan.layoutVersion ||
      bounds.width !== plan.bounds.width ||
      bounds.height !== plan.bounds.height ||
      !withinRegions(start, point, plan.regions)
    )
      return false;

    if (plan.target === "door" && !sameBounds(plan.anchor, context.door))
      return false;
    if (
      plan.target?.type === "near-resident" &&
      !sameBounds(
        plan.anchor,
        context.obstacles.find(
          ({ ref, privatePosition }) =>
            !privatePosition && ref === plan.target.residentRef,
        )?.bounds,
      )
    )
      return false;

    const occupied = this.#obstacles(
      context,
      plan.crossDisplay,
      plan.regions,
      plan.localBounds,
    );
    return occupied.every(
      (rect) =>
        depth(plan.destination, rect) <= 0 &&
        clears(start, point, rect, plan.regions),
    );
  }

  pointTarget(agentId, displayId, point) {
    if (!this.#context(agentId)) return;
    const displayRef = this.#displayRefs.get(displayId);
    if (displayRef)
      return {
        layoutVersion: this.layoutVersion,
        target: { type: "point", displayRef, ...point },
      };
  }

  residentTarget(agentId, peerId) {
    const context = this.#context(agentId);
    const peer = context?.obstacles.find(
      ({ id, privatePosition }) => id === peerId && !privatePosition,
    );
    if (peer)
      return {
        layoutVersion: this.layoutVersion,
        target: { type: "near-resident", residentRef: peer.ref },
      };
  }
}
