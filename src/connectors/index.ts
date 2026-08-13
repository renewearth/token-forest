import type { Connector } from "./types";
import { anthropicConnector } from "./anthropic";
import { copilotConnector } from "./copilot";
import { cursorConnector } from "./cursor";

// Connector registry. Adding a tool (OpenCode, Alibaba Cloud, ...) means
// adding one file that exports a Connector and listing it here.
// A connector registers itself even when its env vars are missing; it throws
// a descriptive error from fetchDaily instead, so `pnpm sync` can report
// which credentials are absent.
const connectors: Connector[] = [
  cursorConnector,
  anthropicConnector,
  copilotConnector,
];

export function allConnectors(): Connector[] {
  return connectors;
}

export function connectorFor(tool: string): Connector | undefined {
  return connectors.find((c) => c.tool === tool);
}

export type { Connector };
