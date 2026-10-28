// NapCat message segments use `file` for the display name; upload notices use
// `name`. Resolve both here and when reading older persisted events.
export function attachmentName(data) {
  for (const value of [data?.name, data?.file_name, data?.file])
    if (
      typeof value === "string" &&
      value &&
      !/[\\/]/.test(value) &&
      !value.includes("\0")
    )
      return value;
  return "";
}
