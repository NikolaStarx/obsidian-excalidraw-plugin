import { FRONTMATTER_KEYS } from "src/constants/constants";

export enum TextMode {
  parsed = "parsed",
  raw = "raw",
}

export function getTextMode(data: string): TextMode {
  const pluginKey = FRONTMATTER_KEYS.plugin.name;
  const parsed =
    data.search(`${pluginKey}: parsed\n`) > -1 ||
    data.search(`${pluginKey}: locked\n`) > -1;
  return parsed ? TextMode.parsed : TextMode.raw;
}
