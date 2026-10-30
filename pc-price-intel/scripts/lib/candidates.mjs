// Review queue. Anything collected from the web, a pasted listing, or another tool lands here
// FIRST. Nothing reaches statistics until a human picks component / type / condition and
// confirms. Confirmed rows are stored as evidence "reported" at the "online_domestic" level
// by default, so they form their own groups and never mix with in-person shop quotes.

import { COMPONENTS, CONDITIONS, LEVELS, PRICE_TYPES } from "./consts.mjs";
import { PcpError } from "./errors.mjs";
import { cleanListingTitle, extractPrices, guessName } from "./extract.mjs";
import { logObservation } from "./observations.mjs";
import { ev } from "./store.mjs";

export function addCandidates(ctx, inputs, state = ctx.store.state()) {
  let id = state.maxCandId;
  const events = inputs
    .filter((c) => c.raw_name && Number.isFinite(c.price_minor) && c.price_minor > 0)
    .slice(0, 50)
    .map((c) =>
      ev("cand", {
        id: ++id,
        source: String(c.source || "agent").slice(0, 60),
        source_url: c.source_url ? String(c.source_url).slice(0, 2000) : null,
        component: c.component && COMPONENTS.includes(String(c.component).toUpperCase()) ? String(c.component).toUpperCase() : null,
        raw_name: cleanListingTitle(c.raw_name, ctx.profile).slice(0, 200),
        price_minor: Math.round(c.price_minor),
        currency: String(c.currency || ctx.profile.currency).toUpperCase().slice(0, 3),
        price_type: c.price_type && PRICE_TYPES.includes(c.price_type) ? c.price_type : null,
        condition: c.condition && CONDITIONS.includes(c.condition) ? c.condition : null,
        quote: c.quote ? String(c.quote).slice(0, 500) : null,
      }),
    );
  ctx.store.append(events);
  return events.map((e) => e.id);
}

/** Free text (pasted listing, scraped page, webhook body) -> candidates with verbatim quotes. */
export function candidatesFromText(ctx, { text, source, url, name, component, pattern, queue = true }) {
  const body = String(text).slice(0, 60000);
  const found = extractPrices(body, ctx.profile, { pattern });
  const raw_name = (name && name.trim()) || guessName(body) || "unnamed listing";
  let ids = [];
  if (queue) {
    ids = addCandidates(
      ctx,
      found.map((f) => ({ source, source_url: url, component, raw_name, price_minor: f.value_minor, currency: f.currency, quote: f.quote })),
    );
  }
  return { found, queued_ids: ids, name: raw_name };
}

export function confirmCandidate(ctx, id, choice, state = ctx.store.state()) {
  const c = state.candById.get(Number(id));
  if (!c || c.status !== "pending") throw new PcpError("NOT_FOUND", `Candidate ${id} not found or already decided.`);
  if (c.currency !== ctx.profile.currency) {
    throw new PcpError("REFERENCE_ONLY", `Candidate ${id} is in ${c.currency}, not ${ctx.profile.currency}. It can only be kept as a reference.`, "Use `pcp log --evidence reference --currency ...` if you want to keep it as a benchmark row.");
  }
  const level = choice.level && LEVELS.includes(choice.level) ? choice.level : "online_domestic";
  const note = [`Collected via ${c.source}`, c.quote ? `Quote: "${c.quote}"` : null].filter(Boolean).join(" · ");
  const major = c.price_minor / 10 ** ctx.profile.decimals;
  const res = logObservation(
    ctx,
    {
      component: choice.component || c.component,
      name: choice.name || c.raw_name,
      price: major,
      type: choice.type || c.price_type,
      condition: choice.condition || c.condition,
      level,
      date: choice.date,
      notes: note,
      evidence: "reported",
      source: c.source_url,
    },
    state,
  );
  ctx.store.append([ev("cand_decide", { id: c.id, status: "confirmed", observation_uuid: res.event.uuid })]);
  return res;
}

export function discardCandidate(ctx, id, state = ctx.store.state()) {
  const c = state.candById.get(Number(id));
  if (!c || c.status !== "pending") throw new PcpError("NOT_FOUND", `Candidate ${id} not found or already decided.`);
  ctx.store.append([ev("cand_decide", { id: c.id, status: "discarded" })]);
  return c;
}
