// Context = which country we are working in. The agent decides this ONCE (from the user's
// words, or by asking) and the CLI remembers it. There is deliberately no silent default:
// guessing the wrong country would mix currencies and markets.

import path from "node:path";
import { loadConfig } from "./config.mjs";
import { PcpError } from "./errors.mjs";
import { dataRoot, readJsonIfExists, writeJsonAtomic } from "./paths.mjs";
import { loadProfile, normalizeCountryCode } from "./profiles.mjs";
import { Store } from "./store.mjs";
import { localDate, nowUtc } from "./timeutil.mjs";

const rootConfigFile = () => path.join(dataRoot(), "config.json");

export function resolveCountryCode(flags = {}) {
  if (flags.country) return normalizeCountryCode(flags.country);
  if (process.env.PCP_COUNTRY) return normalizeCountryCode(process.env.PCP_COUNTRY);
  const root = readJsonIfExists(rootConfigFile());
  if (root?.active_country) return normalizeCountryCode(root.active_country);
  throw new PcpError(
    "NO_COUNTRY",
    "No country is set, so the tool does not know which market or currency to use.",
    "Work out the user's country (ask if it is not obvious), then run: pcp init --country <ISO code>. List options with: pcp country list.",
  );
}

export function activeCountry() {
  return readJsonIfExists(rootConfigFile())?.active_country || null;
}

export function setActiveCountry(cc) {
  writeJsonAtomic(rootConfigFile(), { ...(readJsonIfExists(rootConfigFile()) || {}), active_country: cc });
}

export function makeContext(flags = {}, opts = {}) {
  const cc = resolveCountryCode(flags);
  const profile = loadProfile(cc, opts.profileOpts || {});
  const config = loadConfig(cc, profile);
  const store = new Store(cc);
  const tz = config.timezone;
  return {
    cc,
    profile,
    config,
    store,
    tz,
    today: () => localDate(nowUtc(), tz),
  };
}
