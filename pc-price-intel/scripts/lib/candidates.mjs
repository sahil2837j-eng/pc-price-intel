// Review queue. Anything collected from the web, a pasted listing, or another tool lands here
// FIRST. Nothing reaches statistics until a human picks component / type / condition and
// confirms. Confirmed rows are stored as evidence "reported" at the "online_domestic" level
// by default, so they form their own groups and never mix with in-person shop quotes.

import { COMPONENTS, CONDITIONS, EVIDENCE, LEVELS, PRICE_TYPES } from "./consts.mjs";
import { PcpError } from "./errors.mjs";
import { cleanListingTitle, extractPrices, guessName } from "./extract.mjs";
import { currencyDecimals } from "./money.mjs";
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
        seller: c.seller ? String(c.seller).slice(0, 120) : null,
        location: c.location ? String(c.location).slice(0, 120) : null,
        evidence: c.evidence && EVIDENCE.includes(c.evidence) ? c.evidence : null,
        level: c.level && LEVELS.includes(c.level) ? c.level : null,
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
  const foreign = c.currency !== ctx.profile.currency;
  const evidence = choice.evidence || c.evidence || "reported";
  if (!["reported", "reference"].includes(evidence)) {
    throw new PcpError("VALIDATION", "Candidate evidence must be reported or reference.", "A web listing is never evidence of a completed sale.");
  }
  if (foreign && evidence !== "reference") {
    throw new PcpError("REFERENCE_ONLY", `Candidate ${id} is in ${c.currency}, not ${ctx.profile.currency}. It can only be kept as a reference.`, "Add --evidence reference to keep it as a benchmark row, or log it yourself with pcp log --evidence reference.");
  }
  const level = choice.level && LEVELS.includes(choice.level) ? choice.level : c.level && LEVELS.includes(c.level) ? c.level : "online_domestic";
  const note = [`Collected via ${c.source}`, c.quote ? `Quote: "${c.quote}"` : null].filter(Boolean).join(" · ");
  const decimals = foreign ? currencyDecimals(c.currency) : ctx.profile.decimals;
  const major = c.price_minor / 10 ** decimals;
  const res = logObservation(
    ctx,
    {
      component: choice.component || c.component,
      name: choice.name || c.raw_name,
      price: major,
      currency: c.currency,
      type: choice.type || c.price_type,
      condition: choice.condition || c.condition,
      level,
      date: choice.date,
      seller: choice.seller || c.seller,
      location: choice.location || c.location,
      notes: note,
      evidence,
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
