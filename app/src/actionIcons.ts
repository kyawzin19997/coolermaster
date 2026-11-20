import paths from "./action-icons.json";

const actionPaths: Readonly<Record<string, string>> = paths;
export const actionIconPath = (action: string) => Object.prototype.hasOwnProperty.call(actionPaths, action) ? actionPaths[action] : undefined;
export const actionIconName = (action: string, fallback: string) => actionIconPath(action) ? `action:${action}` : fallback;

export function defaultActionIcon(action: string) {
  const path = actionIconPath(action);
  return path ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>` : undefined;
}
