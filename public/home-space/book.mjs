// @ts-check
import { renderPaperBoard } from "../home-preview/paper-board.mjs";

/** @typedef {{type: "living" | "hall" | "room", page?: number}} BookRoute */

// The portrait presentation uses the same saved overrides and asset catalog.
// Keep attached papers on their furniture when the page becomes taller.
/** @param {Parameters<typeof renderPaperBoard>[0]} options */
export function renderBookScene(options) {
  const { template, mobile, kind } = options;
  if (!mobile || kind === "living") return renderPaperBoard(options);
  const attachedY = /** @type {Record<string, number>} */ ({
    lamp: 71,
    card: 71,
    nameplate: 64,
  });
  const portrait = {
    ...template,
    objects: template.objects.map(
      (/** @type {import("../home-preview/scene.mjs").Instance} */ o) => ({
        ...o,
        phone: {
          ...o.base,
          y:
            kind === "hall" && o.id.startsWith("sign-")
              ? 64
              : kind === "room"
                ? (attachedY[o.id] ?? o.base.y)
                : o.base.y,
        },
      }),
    ),
  };
  return renderPaperBoard({
    ...options,
    template: portrait,
    objects: portrait.objects,
  });
}

/** @param {BookRoute | null} from @param {BookRoute} to */
export function turnDirection(from, to) {
  if (!from) return 0;
  const rank = { living: 0, hall: 1, room: 2 };
  return Math.sign(
    rank[to.type] - rank[from.type] || (to.page || 1) - (from.page || 1),
  );
}

/** @param {HTMLElement} stage */
export function createPageTurn(stage) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let generation = 0,
    finish = () => {};
  function settle() {
    generation++;
    finish();
    finish = () => {};
    stage.removeAttribute("aria-busy");
  }
  reduced.addEventListener("change", () => {
    if (reduced.matches) settle();
  });
  return {
    finish: settle,
    clear() {
      settle();
      stage.replaceChildren();
      delete stage.dataset.route;
    },
    /** @param {HTMLElement} page @param {number} direction */
    async show(page, direction = 0) {
      settle();
      const own = generation,
        previous = /** @type {HTMLElement | null} */ (stage.firstElementChild);
      if (!previous || !direction || reduced.matches || !page.animate) {
        stage.replaceChildren(page);
        return true;
      }
      previous.inert = true;
      previous.setAttribute("aria-hidden", "true");
      stage.setAttribute("aria-busy", "true");
      stage.append(page);
      previous.classList.add("book-old");
      finish = () => {
        previous.remove();
        page.classList.remove("book-turning");
        for (const animation of page.getAnimations()) animation.cancel();
        for (const animation of previous.getAnimations()) animation.cancel();
        stage.querySelector(".book-shadow")?.remove();
      };
      await Promise.all(
        [...page.querySelectorAll("img")].map((img) =>
          img.decode().catch(() => {}),
        ),
      );
      if (own !== generation) return false;
      const turning = direction > 0 ? previous : page;
      turning.classList.add("book-turning");
      const shadow = document.createElement("div");
      shadow.className = "book-shadow";
      stage.append(shadow);
      const frames = [
        { transform: "rotateY(0deg)" },
        { transform: "rotateY(-108deg)" },
      ];
      const options = /** @type {KeyframeAnimationOptions} */ ({
        duration: 750,
        easing: "cubic-bezier(.25,.1,.25,1)",
        fill: "forwards",
      });
      const animation = turning.animate(
        direction > 0 ? frames : frames.toReversed(),
        options,
      );
      shadow.animate(
        [{ opacity: 0 }, { opacity: 0.5, offset: 0.4 }, { opacity: 0 }],
        { duration: 750 },
      );
      await animation.finished.catch(() => {});
      if (own !== generation) return false;
      settle();
      return true;
    },
  };
}
