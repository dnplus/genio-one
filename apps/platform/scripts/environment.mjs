import { parseEnv } from "node:util";

export function parseEnvironment(source) {
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.at(-1) !== quote) {
      throw new Error(`unterminated quoted environment value on line ${index + 1}`);
    }
  }
  return parseEnv(source);
}
