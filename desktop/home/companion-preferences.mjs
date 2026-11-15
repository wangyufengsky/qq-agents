const modes = new Set(["privacy", "presence", "work"]);
const defaults = [
  "1password",
  "1password.exe",
  "com.1password.1password",
  "bitwarden",
  "bitwarden.exe",
  "com.bitwarden.desktop",
  "keepass",
  "keepass.exe",
  "keepassxc",
  "keepassxc.exe",
  "org.keepassxc.keepassxc",
  "keychain access",
  "com.apple.keychainaccess",
  "passwords",
  "com.apple.passwords",
  "securityagent",
  "com.apple.securityagent",
  "credentialuibroker.exe",
  "logonui.exe",
];

const normalize = (value) => value.normalize("NFKC").trim().toLowerCase();

export function companionMode(value) {
  return modes.has(value) ? value : undefined;
}

export function sensitiveApplications(value) {
  if (!Array.isArray(value) || value.length > 60) return;
  if (
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.length > 100 ||
        /[\p{Cc}\p{Cf}]/u.test(entry),
    )
  )
    return;
  return [...new Set(value.map(normalize))];
}

export function sensitiveWindow(
  blocked,
  { app, owner, name, bundle, process },
) {
  const identities = [app, owner, name, bundle, process]
    .filter((value) => typeof value === "string" && value.trim())
    .map(normalize);
  if (!identities.length) return;
  return identities.some(
    (identity) => blocked.includes(identity) || defaults.includes(identity),
  );
}
