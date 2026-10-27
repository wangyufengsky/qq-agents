// Protection is monotonic: editing text or removing evidence cannot declassify
// information already incorporated into a saved record.
export function mergeProtection(...records) {
  const repositories = new Set();
  for (const record of records) {
    const values = record?.protectedRepositories;
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.some((v) => typeof v !== "string" || !v)
    )
      throw Error("INVALID_PROTECTION_METADATA");
    for (const repo of values) repositories.add(repo.toLowerCase());
  }
  return {
    ...(records.some((r) => r?.protectedOperations === true)
      ? { protectedOperations: true }
      : {}),
    ...(repositories.size
      ? { protectedRepositories: [...repositories].sort() }
      : {}),
  };
}
