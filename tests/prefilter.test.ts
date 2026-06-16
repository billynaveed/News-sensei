/**
 * Regression tests for matchesBusinessPrefilter — the cheap keyword gate that
 * decides whether an article reaches the (paid) AI pipeline. Extracted from
 * scanForLeads during decomposition; this locks its behavior.
 */
import { matchesBusinessPrefilter } from "../server/prefilter";
import { check } from "./harness";

const pass = [
  { headline: "Acme raises Series B funding round", content: "" },
  { headline: "", content: "The startup founder announced a surprise IPO" },
  { headline: "Tycoon completes US$2 billion acquisition", content: "deal closed" },
];
const reject = [
  { headline: "Local football team wins derby", content: "great game last night" },
  { headline: "Tomorrow's weather forecast", content: "sunny with light winds" },
];

for (const a of pass) check(`prefilter passes: "${a.headline || a.content}"`, matchesBusinessPrefilter(a) === true, "expected pass");
for (const a of reject) check(`prefilter rejects: "${a.headline || a.content}"`, matchesBusinessPrefilter(a) === false, "expected reject");
