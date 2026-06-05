import { invokeBrowserTool } from "./invoke.js";
import type { BrowserTool } from "../types.js";

const LOCATION_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

/** `get_user_location` — device geolocation via the browser. */
export function locationTool(): BrowserTool {
  return {
    name: "get_user_location",
    label: "Get location",
    description:
      "Get the user's current geographic location (latitude/longitude, and " +
      "a human-readable place name when available) from their device. Call " +
      "this whenever you need to know WHERE the user is to answer — e.g. " +
      "they ask about nearby places, local weather, directions, or 'where " +
      "am I'. Prompts the user's browser for location permission.",
    promptSnippet:
      "get_user_location: get the user's current location when they ask about nearby places, local conditions, or where they are.",
    parameters: LOCATION_PARAMS,
    execute(_toolCallId, _params, signal) {
      return invokeBrowserTool("get_user_location", {}, signal);
    },
  };
}
