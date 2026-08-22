#!/usr/bin/env node
/**
 * Records a real, conservative full-run result.
 *
 * Run this only after the agent has opened every browser-labelled source in
 * its Browser tool. The script itself collects the one supported public API
 * (China Telecom); browser sources remain explicitly incomplete until their
 * recipe has completed filtering, pagination, attachments and detail checks.
 */
import { readFile, writeFile } from "node:fs/promises";
import { collectChinaTelecom } from "./collect-chinatelecom.mjs";

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));
if (!args.has("--browser-checked")) {
  throw new Error("先在 Browser 中逐页打开所有 browser 来源，再带 --browser-checked 记录本轮；不得用此脚本代替浏览器核验。");
}

function shanghaiMinute() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

async function main() {
  const [registry, recipes, sourcePlan, log, opportunities] = await Promise.all([
    readJson("data/source-registry.json"), readJson("data/filter-recipes.json"), readJson("data/source-plan.json"),
    readJson("data/review-log.json"), readJson("data/opportunities.json")
  ]);
  const checkedAt = shanghaiMinute();
  const sources = new Map(registry.sources.map((source) => [source.id, source]));
  const telecom = await collectChinaTelecom({
    entryUrl: sources.get("chinatelecom-careers").entryUrl,
    city: recipes.city,
    allPages: true
  });
  const officialIds = sourcePlan.coverage.everyRunOfficial;
  const sourceChecks = officialIds.map((sourceId) => {
    const source = sources.get(sourceId);
    if (sourceId === "chinatelecom-careers") {
      return {
        sourceId, status: "checked-full-pagination", attempts: 1, checkedAt,
        note: `已按官网“校园招聘 + ${recipes.city}”筛选完成 ${telecom.filteredPages} 页、${telecom.deduplicatedPositions.length} 个去重候选。候选尚未逐项详情审核。`,
        accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: source.entryUrl, outcome: "official-page", recipe: `官网城市筛选 ${telecom.unfilteredTotal} → ${telecom.filteredTotal}` }]
      };
    }
    return {
      sourceId, status: "accessible-incomplete", attempts: 1, checkedAt,
      note: "本轮已在 Browser 打开登记官方入口并确认是非错误页面；尚未完成该来源的站内筛选、全部分页、附件和候选详情核验，不能发布岗位。",
      accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: source.entryUrl, outcome: "page-incomplete", recipe: "入口可用；按 filter-recipes.json 继续完成浏览器采集。" }]
    };
  });
  const incomplete = sourceChecks.filter((check) => check.status === "accessible-incomplete").length;
  const run = {
    id: `run-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-full-route-audit`,
    scope: "full-city-run", checkedAt, trigger: "manual-full-workflow-test", policyVersion: 6,
    screeningStrategyVersion: 2, coverageStatus: "all-official-sources-covered",
    status: "completed-partial", outcome: "browser-routes-verified-script-collection-complete",
    summary: `已逐页打开 ${officialIds.length} 个官方入口；中国电信已按 ${recipes.city} 官网筛选全量采集 ${telecom.deduplicatedPositions.length} 个候选。其余浏览器来源尚待按各自配方完成筛选和逐项核验，因此本轮不发布岗位。`,
    metrics: {
      officialSystemsChecked: officialIds.length, officialSystemsSucceeded: officialIds.length - incomplete,
      officialSystemsFailed: incomplete, newLeads: telecom.deduplicatedPositions.length,
      reviewedItems: 0, accepted: 0, rejected: 0, deferred: 0, published: 0, updated: 0, closed: 0
    },
    screeningMetrics: {
      portalResultsReported: telecom.unfilteredTotal, nativeFilterQueries: 1,
      nativeFilteredResults: telecom.filteredTotal, deduplicatedCandidates: telecom.deduplicatedPositions.length,
      positionsBatchReviewed: 0, positionsOfficiallyVerified: 0, positionsEscalated: 0,
      positionsDeferredByBudget: telecom.deduplicatedPositions.length, discoverySourcesChecked: 0, discoveryOfficialCandidates: 0
    },
    sourceChecks, reviews: []
  };
  if (!args.has("--write")) {
    console.log(JSON.stringify({ dryRun: true, checkedAt, city: recipes.city, run }, null, 2));
    return;
  }
  for (const previousRun of log.runs) for (const check of previousRun.sourceChecks || []) for (const evidence of check.accessEvidence || []) {
    if (evidence.outcome === "browser-ui-verified") evidence.outcome = "page-incomplete";
    if (evidence.outcome === "official-native-filtered") evidence.outcome = "official-page";
  }
  log.meta.initializationStatus = "synchronized";
  log.meta.lastRunAt = checkedAt;
  log.runs.unshift(run);
  opportunities.meta.initializationStatus = "synchronized";
  opportunities.meta.lastVerifiedAt = checkedAt;
  opportunities.meta.lastRunStatus = run.status;
  opportunities.meta.lastIncompleteSourceCount = incomplete;
  opportunities.meta.lastDeferredCandidateCount = telecom.deduplicatedPositions.length;
  await Promise.all([
    writeFile(new URL("data/review-log.json", root), `${JSON.stringify(log, null, 2)}\n`),
    writeFile(new URL("data/opportunities.json", root), `${JSON.stringify(opportunities, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ written: true, city: recipes.city, checkedAt, candidates: telecom.deduplicatedPositions.length, incomplete }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
