import { defaultGardenSettings } from "../src/home/garden-rules.mjs";

export function fixedWeather(kind = "cloud") {
  const settings = defaultGardenSettings();
  settings.weather.fallback = kind;
  for (const entry of Object.values(settings.weather.entries)) entry.weight = 0;
  return settings.weather;
}

export function keepNeutralWeather(garden) {
  const initialize = garden.initialize.bind(garden);
  garden.initialize = (now, settings = defaultGardenSettings()) =>
    initialize(now, {
      ...settings,
      events: { ...settings.events, rate: 0 },
      weather: fixedWeather(),
    });
}
