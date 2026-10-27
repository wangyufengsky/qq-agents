// Child programs receive an explicit operational environment, never the bridge's
// credential bag. These lists are launch compatibility policy, not an OS sandbox.
const base = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
];
const network = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];
const windows = [
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
];
const desktop = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
];
const targetName = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const sourceName = /^[A-Z][A-Z0-9_]{0,100}$/;

export function buildChildEnv(
  component,
  explicitMappings = {},
  { parent = process.env, platform = process.platform } = {},
) {
  if (!["codex", "native-qq"].includes(component))
    throw Error("INVALID_CHILD_ENV_COMPONENT");
  if (
    !explicitMappings ||
    typeof explicitMappings !== "object" ||
    Array.isArray(explicitMappings)
  )
    throw Error("INVALID_CHILD_ENV_MAPPING");
  const canonical = (key) => (platform === "win32" ? key.toUpperCase() : key);
  const keys = Object.keys(parent).sort();
  const read = (key) => {
    const name = canonical(key);
    const source = Object.hasOwn(parent, name)
      ? name
      : platform === "win32"
        ? keys.find((k) => k.toUpperCase() === name)
        : undefined;
    return source === undefined ? undefined : parent[source];
  };
  const env = Object.create(null);
  const allowed = [
    ...base,
    ...network,
    ...(platform === "win32" ? windows : []),
    ...(component === "native-qq" && platform === "linux" ? desktop : []),
    ...(component === "native-qq" && platform === "darwin"
      ? ["__CF_USER_TEXT_ENCODING"]
      : []),
  ];
  for (const key of allowed) {
    const value = read(key);
    if (
      typeof value === "string" &&
      !value.includes("\0") &&
      !value.startsWith("()")
    )
      env[canonical(key)] = value;
  }
  const mapped = new Set();
  for (const [key, ref] of Object.entries(explicitMappings)) {
    if (
      !targetName.test(key) ||
      typeof ref !== "string" ||
      !sourceName.test(ref) ||
      mapped.has(canonical(key))
    )
      throw Error("INVALID_CHILD_ENV_MAPPING");
    if (component === "codex" && key.toUpperCase() === "CODEX_HOME")
      throw Error("CODEX_HOME_OVERRIDE_DENIED");
    mapped.add(canonical(key));
    const value = read(ref);
    if (typeof value !== "string" || !value || value.includes("\0"))
      throw Error(
        component === "codex" ? "CODEX_ENV_MISSING" : "PROCESS_ENV_MISSING",
      );
    env[canonical(key)] = value;
  }
  return env;
}
