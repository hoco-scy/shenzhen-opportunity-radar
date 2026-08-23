#!/usr/bin/env node
/**
 * Full city sync. Aggregate platforms are the discovery front door; a
 * discovery record can never publish a job until its employer/government
 * source has been verified separately.
 */
import { readFile, writeFile } from "node:fs/promises";
import { buildPublicExamRun } from "./run-public-exam-sync.mjs";
import { collectBuaaDiscovery } from "./collect-buaa-discovery.mjs";

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));
if (!args.has("--full-update")) throw new Error("请使用 --full-update 执行完整采集；不能用入口探测冒充完整更新。");

function shanghaiMinute() {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

async function readJson(path) { return JSON.parse(await readFile(new URL(path, root), "utf8")); }

async function probeOfficialEntry(source, checkedAt) {
  const urls = [source.collectionEntryUrl || source.entryUrl, ...(source.alternateEntryUrls || [])];
  const attempts = Math.max(["critical", "active"].includes(source.tier) ? 3 : 1, urls.length);
  const accessEvidence = [];
  let usable = false;
  let semantic404 = false;
  for (let index = 0; index < attempts && !usable; index += 1) {
    const requestedUrl = urls[index % urls.length];
    try {
      const response = await fetch(requestedUrl, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "Mozilla/5.0" } });
      const body = (await response.text()).slice(0, 12_000);
      const isSemantic404 = /(?:页面不存在|not found|error 404|访问出错)/i.test(body) || /(?:\/404|\/error)(?:[/?#]|$)/i.test(response.url);
      if (response.ok && !isSemantic404) {
        usable = true;
        accessEvidence.push({ requestedUrl, finalUrl: response.url, outcome: "page-incomplete", recipe: "公开入口可打开；尚未完成本站筛选、分页、附件和逐岗核验。" });
      } else if (isSemantic404) {
        semantic404 = true;
        accessEvidence.push({ requestedUrl, outcome: "semantic-404", recipe: "公开入口返回明确的不存在或错误页。" });
      } else accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口返回 HTTP ${response.status}。` });
    } catch (error) {
      accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口本轮无法连接：${error?.name || "fetch-error"}。` });
    }
  }
  if (usable) return { sourceId: source.id, status: "accessible-incomplete", attempts: accessEvidence.length, checkedAt, note: "入口可访问，但本轮尚未在该来源完成原生筛选、分页、附件与逐岗核验；不据此发布岗位。", accessEvidence };
  if (semantic404) return { sourceId: source.id, status: "semantic-404", attempts: accessEvidence.length, checkedAt, note: "已按登记入口与备用入口重试，未取得可用页面；不据此判断无岗位。", accessEvidence };
  return { sourceId: source.id, status: "temporarily-unavailable", attempts: accessEvidence.length, checkedAt, note: "已按登记入口与备用入口重试，公开页面本轮仍不可用；不据此判断无岗位。", accessEvidence };
}

function buaaSourceCheck(source, result, checkedAt) {
  return {
    sourceId: source.id, status: "checked-native-filtered", attempts: 1, checkedAt,
    note: `已按北航就业信息网“${result.city}＋单位性质＋生物医学相关词”执行 ${result.nativeFilterQueries} 组原生筛选，读取 ${result.deduplicatedCandidates} 条去重候选详情；其中 ${result.leads.length} 条待回溯单位或政府官方页面，北航转载本身不作为发布证据。`,
    accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: result.pagesVisited[0], outcome: "official-page", recipe: result.collectionRoute }]
  };
}

function incompleteCount(checks) { return checks.filter((check) => ["accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"].includes(check.status)).length; }

async function main() {
  const [registry, recipes, sourcePlan, log, opportunities] = await Promise.all([
    readJson("data/source-registry.json"), readJson("data/filter-recipes.json"), readJson("data/source-plan.json"), readJson("data/review-log.json"), readJson("data/opportunities.json")
  ]);
  const checkedAt = shanghaiMinute();
  const sources = new Map(registry.sources.map((source) => [source.id, source]));
  const [publicExamRun, buaa] = await Promise.all([buildPublicExamRun({ registry, recipes, checkedAt }), collectBuaaDiscovery({ city: recipes.city })]);
  const publicExamChecks = new Map(publicExamRun.sourceChecks.map((check) => [check.sourceId, check]));
  const scheduledIds = [...new Set([...(sourcePlan.coverage.everyRunOfficial || []), ...(sourcePlan.coverage.everyRunDiscovery || [])])];
  const sourceChecks = await Promise.all(scheduledIds.map(async (sourceId) => {
    const source = sources.get(sourceId);
    if (!source) throw new Error(`source-plan 引用了不存在的来源：${sourceId}`);
    if (publicExamChecks.has(sourceId)) return publicExamChecks.get(sourceId);
    if (sourceId === "buaa-career-discovery") return buaaSourceCheck(source, buaa, checkedAt);
    return probeOfficialEntry(source, checkedAt);
  }));
  const incomplete = incompleteCount(sourceChecks);
  const publicMetrics = publicExamRun.screeningMetrics || {};
  const run = {
    id: `run-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-aggregate-first-full-sync`,
    scope: "full-city-run", checkedAt, trigger: "scheduled-or-manual-full-update", policyVersion: 6,
    screeningStrategyVersion: 2, candidateProcessingVersion: 4,
    coverageStatus: "aggregate-first-collection-and-source-health",
    status: incomplete ? "completed-partial" : "completed",
    outcome: "aggregate-platform-discovery-plus-official-verification",
    summary: `本轮已实际执行国考、本地公考、选调优培及北航就业信息网的城市原生筛选。北航发现 ${buaa.leads.length} 条需回溯单位或政府官方页面的线索；国聘和国家大学生就业服务平台等浏览器路线、以及重点官网未完成原生筛选的来源均明确记为未完成，不据此发布岗位。`,
    metrics: {
      officialSystemsChecked: sourceChecks.length, officialSystemsSucceeded: sourceChecks.length - incomplete, officialSystemsFailed: incomplete,
      newLeads: (publicExamRun.metrics?.newLeads || 0) + buaa.leads.length,
      reviewedItems: publicExamRun.reviews.length, accepted: 0, rejected: 0, deferred: publicExamRun.reviews.length,
      published: 0, updated: 0, closed: 0
    },
    screeningMetrics: {
      portalResultsReported: (publicMetrics.portalResultsReported || 0) + buaa.portalResultsReported,
      nativeFilterQueries: (publicMetrics.nativeFilterQueries || 0) + buaa.nativeFilterQueries,
      nativeFilteredResults: (publicMetrics.nativeFilteredResults || 0) + buaa.nativeFilteredResults,
      deduplicatedCandidates: (publicMetrics.deduplicatedCandidates || 0) + buaa.deduplicatedCandidates,
      positionsBatchReviewed: (publicMetrics.positionsBatchReviewed || 0) + buaa.detailsChecked,
      positionsOfficiallyVerified: publicMetrics.positionsOfficiallyVerified || 0,
      positionsEscalated: 0, positionsDeferredByBudget: publicMetrics.positionsDeferredByBudget || 0,
      discoverySourcesChecked: 1, discoveryOfficialCandidates: buaa.leads.length
    },
    sourceChecks, reviews: publicExamRun.reviews
  };
  if (!args.has("--write")) { console.log(JSON.stringify({ dryRun: true, city: recipes.city, run }, null, 2)); return; }
  log.meta.initializationStatus = "synchronized";
  log.meta.lastRunAt = checkedAt;
  log.runs = log.runs.filter((previous) => !previous.id?.endsWith("-full-route-audit") && previous.outcome !== "all-official-sources-checked" && previous.id !== run.id);
  log.runs.unshift(run);
  opportunities.meta.initializationStatus = "synchronized";
  opportunities.meta.lastVerifiedAt = checkedAt;
  opportunities.meta.lastRunStatus = run.status;
  opportunities.meta.lastIncompleteSourceCount = incomplete;
  opportunities.meta.lastDeferredCandidateCount = run.screeningMetrics.positionsDeferredByBudget;
  await Promise.all([
    writeFile(new URL("data/review-log.json", root), `${JSON.stringify(log, null, 2)}\n`),
    writeFile(new URL("data/opportunities.json", root), `${JSON.stringify(opportunities, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ written: true, city: recipes.city, checkedAt, buaaLeads: buaa.leads.length, incomplete }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
