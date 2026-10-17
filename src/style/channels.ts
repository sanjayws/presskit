import { isOutputFormat, type OutputFormat } from "./engine";
export const MAX_CHANNELS = 4;
/** Empty legacy lists inherit the original single destination. */
export function selectedChannels(primary: string, stored?: string): OutputFormat[] {
  let parsed: unknown = [];
  try { parsed = JSON.parse(stored || "[]"); } catch { /* legacy fallback */ }
  const valid = Array.isArray(parsed) ? parsed.filter(isOutputFormat) : [];
  return [...new Set<OutputFormat>([isOutputFormat(primary) ? primary : "html", ...valid])].slice(0, MAX_CHANNELS);
}
export function submittedChannels(form: FormData): string[] {
  const primary = form.get("output_format");
  return [...new Set([typeof primary === "string" ? primary || "html" : primary === null ? "html" : "invalid", ...form.getAll("output_formats").map((v) => typeof v === "string" ? v : "invalid")])];
}
