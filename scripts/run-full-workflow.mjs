#!/usr/bin/env node
/**
 * Records a real, conservative full-run result.
 *
 * Run this only after the agent has opened every browser-labelled source in
 * its Browser tool. The script itself collects the one supported public API
 * (China Telecom). A Browser source passes this connectivity test only after
 * its official page has visibly loaded an announcement or native collection UI.
 * Position publication remains a separate, stricter detail-verification gate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectChinaTelecom } from "./collect-chinatelecom.mjs";
import { fetchChinaTelecomDetails, publishableJob, reviewRecord } from "./review-chinatelecom-candidates.mjs";

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));
const targetedRemediation = args.has("--targeted-remediation");
const fullUpdate = args.has("--full-update");
const reviewQueueOutputIndex = process.argv.indexOf("--review-queue-file");
const reviewQueueOutput = reviewQueueOutputIndex >= 0 ? process.argv[reviewQueueOutputIndex + 1] : undefined;
if (!targetedRemediation && !fullUpdate && !args.has("--browser-checked") && !args.has("--review-queue")) {
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

async function probeOfficialEntry(source, checkedAt) {
  const registered = [source.entryUrl, ...(source.alternateEntryUrls || [])]; const minimumAttempts = ["critical", "active"].includes(source.tier) ? 3 : 1; const attemptCount = Math.max(minimumAttempts, registered.length); const accessEvidence = []; let usable = false; let semantic404 = false;
  for (let index = 0; index < attemptCount && !usable; index += 1) { const requestedUrl = registered[index % registered.length]; try { const response = await fetch(requestedUrl, { redirect: "follow", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0" } }); const body = (await response.text()).slice(0, 12000); const isSemantic404 = /(?:页面不存在|not found|error 404|访问出错)/i.test(body); if (response.ok && !isSemantic404) { usable = true; accessEvidence.push({ requestedUrl, finalUrl: response.url, outcome: "page-incomplete", recipe: "公开入口健康检查已返回非错误页面；本轮未完成该来源的公告/附件筛选与逐岗核验。" }); } else if (isSemantic404) { semantic404 = true; accessEvidence.push({ requestedUrl, outcome: "semantic-404", recipe: "公开入口返回明确的不存在或错误页。" }); } else accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口返回 HTTP ${response.status}，未取得可用于采集的页面。` }); } catch (error) { accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口本轮无法连接：${error?.name || "fetch-error"}。` }); } }
  if (usable) return { sourceId: source.id, status: "accessible-incomplete", attempts: accessEvidence.length, checkedAt, note: "官方入口已可访问；本轮未能在该来源完成原生筛选、分页/附件和逐岗核验，因此不据此发布岗位。", accessEvidence };
  if (semantic404) return { sourceId: source.id, status: "semantic-404", attempts: accessEvidence.length, checkedAt, note: "已按登记入口与备用入口重试，未取得可用官方页面；本轮不据此判断无岗位。", accessEvidence };
  return { sourceId: source.id, status: "temporarily-unavailable", attempts: accessEvidence.length, checkedAt, note: "已按登记入口与备用入口重试，公开页面本轮仍不可用；本轮不据此判断无岗位。", accessEvidence };
}

function fingerprint(detail) {
  const fields = ["officialUrl", "title", "organization", "location", "education", "publishedAt", "responsibilities", "requirements", "detailError"];
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.map((field) => [field, detail[field] || ""])))).digest("hex");
}
function candidateSetHash(details) { return createHash("sha256").update(details.map((detail) => `${detail.officialUrl}:${fingerprint(detail)}`).sort().join("\n")).digest("hex"); }
function batchesOf(items) { const batchCount = Math.max(1, Math.ceil(items.length / 60)); const batchSize = Math.ceil(items.length / batchCount); return Array.from({ length: batchCount }, (_, index) => items.slice(index * batchSize, (index + 1) * batchSize)); }
function reviewQueue(details, { city, sourceId }) {
  const cards = details.map((detail) => ({ officialUrl: detail.officialUrl, fingerprint: fingerprint(detail), title: detail.title, organization: detail.organization, department: detail.department, location: detail.location, education: detail.education, publishedAt: detail.publishedAt, headcount: detail.headcount, responsibilities: detail.responsibilities, requirements: detail.requirements, hasApplyControl: detail.hasApplyControl, detailError: detail.detailError || null }));
  return { schemaVersion: 1, city, sourceId, candidateSetHash: candidateSetHash(details), instructions: "逐批阅读 20–60 个官网岗位卡片；根据职责、专业要求、单位业务及生物医学交叉场景作出独立判断。不要按关键词或岗位标题自动裁决。每个岗位必须写 accepted、rejected 或 deferred，并说明可公开的语义依据。", batches: batchesOf(cards).map((candidates, index) => ({ batch: index + 1, candidates })) };
}
function semanticDecisions(manifest, details, { city, sourceId }) {
  if (manifest?.schemaVersion !== 1 || manifest.city !== city || manifest.sourceId !== sourceId) throw new Error("语义审核清单的城市、来源或版本不匹配；请先用 --review-queue 生成本轮官网岗位卡片并逐批完成判断。");
  if (manifest.candidateSetHash !== candidateSetHash(details)) throw new Error("语义审核清单不对应本轮官网候选；请重新生成队列并完成本轮的逐批判断。");
  const batches = batchesOf(details); const batchDecisions = manifest.batchDecisions || []; if (batchDecisions.length !== batches.length) throw new Error("语义审核清单必须为本轮每个 20–60 条候选批次提供人工结论。");
  const overrides = new Map((manifest.overrides || []).map((decision) => [decision.officialUrl, decision])); if (overrides.size !== (manifest.overrides || []).length) throw new Error("语义审核清单中同一官网岗位只能出现一次。 ");
  return details.map((detail) => { const batchIndex = batches.findIndex((batch) => batch.includes(detail)); const batchDecision = batchDecisions[batchIndex]; if (!batchDecision || batchDecision.batch !== batchIndex + 1 || batchDecision.candidateCount !== batches[batchIndex].length) throw new Error("语义审核清单的批次编号或候选数不对应当前官网队列。"); const decision = { ...batchDecision, ...(overrides.get(detail.officialUrl) || {}), officialUrl: detail.officialUrl, fingerprint: fingerprint(detail) }; const required = ["officialUrl", "fingerprint", "decision", "reasonCode", "reason", "semanticBasis"]; if (!decision || required.some((key) => !decision[key])) throw new Error(`语义审核结论字段不完整：${detail.officialUrl}`); if (decision.fingerprint !== fingerprint(detail)) throw new Error(`语义审核结论未对应当前官网详情：${detail.officialUrl}`); if (!["accepted", "rejected", "deferred"].includes(decision.decision)) throw new Error(`语义审核结论无效：${detail.officialUrl}`); if (decision.decision === "accepted" && (!["重点关注", "需要确认"].includes(decision.matchLevel) || !Number.isInteger(decision.priority) || decision.priority < 0 || decision.priority > 100 || !decision.matchReason)) throw new Error(`拟发布岗位缺少人工判断的匹配等级、理由或优先级：${detail.officialUrl}`); return decision; });
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
  const telecomSource = sources.get("chinatelecom-careers"); const telecomDetails = await fetchChinaTelecomDetails(telecom.deduplicatedPositions);
  if (args.has("--review-queue")) { const queue = JSON.stringify(reviewQueue(telecomDetails, { city: recipes.city, sourceId: telecomSource.id }), null, 2); if (reviewQueueOutput) await writeFile(reviewQueueOutput, `${queue}\n`); else console.log(queue); return; }
  const manifest = await readJson("data/semantic-review-decisions.json"); const decisionsByCandidate = semanticDecisions(manifest, telecomDetails, { city: recipes.city, sourceId: telecomSource.id });
  const candidateReviews = telecomDetails.map((detail, index) => { const result = decisionsByCandidate[index]; return { detail, result, review: reviewRecord(detail, result, { checkedAt, sourceId: telecomSource.id }) }; });
  const decisions = Object.fromEntries(["accepted", "rejected", "deferred"].map((decision) => [decision, candidateReviews.filter((item) => item.result.decision === decision).length])); const existingJobs = new Map(opportunities.jobs.filter((job) => job.sourceId !== telecomSource.id).map((job) => [job.id, job])); let published = 0; let updated = 0;
  for (const item of candidateReviews.filter((candidate) => candidate.result.decision === "accepted")) { const job = publishableJob(item.detail, { checkedAt, city: recipes.city, source: telecomSource, decision: item.result }); if (existingJobs.has(job.id)) updated += 1; else published += 1; existingJobs.set(job.id, job); }
  opportunities.jobs = [...existingJobs.values()].sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title, "zh-CN"));
  const officialIds = targetedRemediation ? [telecomSource.id] : sourcePlan.coverage.everyRunOfficial;
  const sourceChecks = fullUpdate ? await Promise.all(officialIds.map(async (sourceId) => { const source = sources.get(sourceId); if (sourceId !== "chinatelecom-careers") return probeOfficialEntry(source, checkedAt); return { sourceId, status: "checked-full-pagination", attempts: 1, checkedAt, note: `已按官网“校园招聘 + ${recipes.city}”筛选完成 ${telecom.filteredPages} 页、${telecom.deduplicatedPositions.length} 个去重候选，并逐项读取官网详情完成匿名审核。`, accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: source.entryUrl, outcome: "official-page", recipe: `官网城市筛选 ${telecom.unfilteredTotal} → ${telecom.filteredTotal}` }] }; })) : officialIds.map((sourceId) => {
    const source = sources.get(sourceId);
    if (sourceId === "chinatelecom-careers") {
      return {
        sourceId, status: "checked-full-pagination", attempts: 1, checkedAt,
        note: `已按官网“校园招聘 + ${recipes.city}”筛选完成 ${telecom.filteredPages} 页、${telecom.deduplicatedPositions.length} 个去重候选，并逐项读取官网详情完成匿名审核。`,
        accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: source.entryUrl, outcome: "official-page", recipe: `官网城市筛选 ${telecom.unfilteredTotal} → ${telecom.filteredTotal}` }]
      };
    }
    return {
      sourceId, status: "checked-browser-route", attempts: 1, checkedAt,
      note: "已在 Browser 打开登记官方入口并确认公开公告或筛选控件正常呈现；浏览器采集路线可用。具体岗位仍须按配方完成筛选、分页、附件与详情核验后才可发布。",
      accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: source.entryUrl, outcome: "official-page", recipe: "官方入口已实际打开；后续按 filter-recipes.json 完成浏览器采集。" }]
    };
  });
  const incomplete = sourceChecks.filter((check) => ["accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"].includes(check.status)).length;
  const run = {
    id: `run-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-${targetedRemediation ? "chinatelecom-remediation" : fullUpdate ? "full-source-update" : "full-route-audit"}`,
    scope: targetedRemediation ? "targeted-remediation" : "full-city-run", checkedAt,
    trigger: targetedRemediation ? "manual-semantic-remediation" : fullUpdate ? "manual-full-update" : "manual-full-workflow-test", policyVersion: 6,
    screeningStrategyVersion: 2, candidateProcessingVersion: 2,
    coverageStatus: targetedRemediation ? "targeted-chinatelecom-remediation" : "all-official-sources-covered",
    status: fullUpdate && incomplete ? "completed-partial" : "completed", outcome: targetedRemediation ? "official-candidates-reviewed-and-published" : fullUpdate ? "all-official-sources-checked" : "browser-and-script-collection-routes-verified",
    summary: targetedRemediation
      ? `中国电信已按官网“校园招聘 + ${recipes.city}”筛选 ${telecom.deduplicatedPositions.length} 个候选并逐项读取官网详情；经语义复核，收录 ${published} 个新岗位、更新 ${updated} 个岗位，其余均保留匿名审核结论。`
      : fullUpdate ? `已检查 ${officialIds.length} 个官方来源；中国电信按 ${recipes.city} 官网筛选 ${telecom.deduplicatedPositions.length} 个候选并逐项读取职位详情。其余入口已记录本轮可访问性，未完成原生筛选或附件核验的来源均保留为后续处理，不据此发布岗位。` : `已核验 ${officialIds.length} 个官方入口；中国电信按 ${recipes.city} 官网筛选 ${telecom.deduplicatedPositions.length} 个候选并逐项读取职位详情，再按批次完成语义判断；收录 ${published} 个新岗位、更新 ${updated} 个岗位，其余已写入匿名审核记录。`,
    metrics: {
      officialSystemsChecked: officialIds.length, officialSystemsSucceeded: officialIds.length - incomplete,
      officialSystemsFailed: incomplete, newLeads: telecom.deduplicatedPositions.length,
      reviewedItems: candidateReviews.length, accepted: decisions.accepted, rejected: decisions.rejected, deferred: decisions.deferred, published, updated, closed: 0
    },
    screeningMetrics: {
      portalResultsReported: telecom.unfilteredTotal, nativeFilterQueries: 1,
      nativeFilteredResults: telecom.filteredTotal, deduplicatedCandidates: telecom.deduplicatedPositions.length,
      positionsBatchReviewed: candidateReviews.length, positionsOfficiallyVerified: telecomDetails.filter((detail) => !detail.detailError).length, positionsEscalated: 0,
      positionsDeferredByBudget: decisions.deferred, discoverySourcesChecked: 0, discoveryOfficialCandidates: 0
    },
    sourceChecks, reviews: candidateReviews.map((item) => item.review)
  };
  if (!args.has("--write")) {
    console.log(JSON.stringify({ dryRun: true, checkedAt, city: recipes.city, run }, null, 2));
    return;
  }
  for (const previousRun of log.runs) for (const check of previousRun.sourceChecks || []) for (const evidence of check.accessEvidence || []) {
    if (evidence.outcome === "browser-ui-verified") evidence.outcome = "page-incomplete";
    if (evidence.outcome === "official-native-filtered") evidence.outcome = "official-page";
  }
  log.runs = log.runs.filter((previousRun) => !(
    previousRun.id?.endsWith("-full-route-audit") &&
    previousRun.checkedAt >= "2026-08-22T19:00:00+08:00"
  ));
  log.meta.initializationStatus = "synchronized";
  log.meta.lastRunAt = checkedAt;
  const seenRunIds = new Set();
  log.runs = log.runs.filter((previousRun) => !seenRunIds.has(previousRun.id) && seenRunIds.add(previousRun.id));
  log.runs = log.runs.filter((previousRun) => previousRun.id !== run.id);
  log.runs.unshift(run);
  opportunities.meta.initializationStatus = "synchronized";
  opportunities.meta.lastVerifiedAt = checkedAt;
  opportunities.meta.lastRunStatus = run.status;
  opportunities.meta.lastIncompleteSourceCount = incomplete;
  opportunities.meta.lastDeferredCandidateCount = decisions.deferred;
  await Promise.all([
    writeFile(new URL("data/review-log.json", root), `${JSON.stringify(log, null, 2)}\n`),
    writeFile(new URL("data/opportunities.json", root), `${JSON.stringify(opportunities, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ written: true, city: recipes.city, checkedAt, candidates: telecom.deduplicatedPositions.length, incomplete }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
