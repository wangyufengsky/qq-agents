import { setTimeout as wait } from "node:timers/promises";

export async function waitForTerminalObservation(endpoint, headers, epoch) {
  // The terminal stdout frame and HTTP requests travel over separate streams.
  const signal = AbortSignal.timeout(10000);
  try {
    for (;;) {
      const response = await fetch(endpoint + "/catalog", { headers, signal });
      const catalogue = await response.json();
      if (
        response.status === 403 &&
        catalogue.error === "ANTIGRAVITY_TURN_INACTIVE"
      )
        return;
      if (
        !response.ok ||
        (epoch !== undefined && typeof catalogue.turnEpoch !== "string")
      )
        throw Error("FIXTURE_TERMINAL_CATALOGUE_FAILED");
      if (epoch !== undefined && catalogue.turnEpoch !== epoch) return;
      await wait(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted)
      throw Error("FIXTURE_TERMINAL_OBSERVATION_TIMEOUT", { cause: error });
    throw error;
  }
}
