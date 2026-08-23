#!/usr/bin/env node
/**
 * Public notice-feed collector for official sources that expose a server
 * rendered recruitment / announcement page.  It is deliberately narrower
 * than a generic crawler: only registered official domains are followed, and
 * it never treats a notice as a publishable job without a concrete position.
 */

const RECRUITMENT_LINK = /(招聘|招考|招录|人才|校园|校招|应届|毕业生|选调|优培|事业单位|岗位|职位)/;
const BIOMEDICAL_CONTEXT = /(生物医学|医疗器械|医学影像|临床工程|医疗|健康|生物工程|生命科学|医药|药学|医院)/i;
const ERROR_PAGE = /(?:页面不存在|not found|error 404|访问出错|系统错误)/i;

export class OfficialNoticeFeedError extends Error {
  constructor(message) { super(message); this.name = "OfficialNoticeFeedError"; }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function officialDomains(source) {
  return new Set((source.domains || []).map((domain) => String(domain).toLowerCase()));
}

function isOfficialUrl(url, domains) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function extractAnchors(html, baseUrl, domains) {
  const links = new Map();
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html))) {
    const title = normalizeText(match[3]);
    if (!title || !RECRUITMENT_LINK.test(title)) continue;
    let url;
    try { url = new URL(match[2], baseUrl).toString(); } catch { continue; }
    if (!isOfficialUrl(url, domains)) continue;
    links.set(url, { url, title });
  }
  return [...links.values()];
}

async function fetchOfficialPage(requestedUrl, domains, fetchImpl) {
  const response = await fetchImpl(requestedUrl, {
    redirect: "follow",
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(25_000)
  });
  const html = await response.text();
  if (!isOfficialUrl(response.url || requestedUrl, domains)) throw new OfficialNoticeFeedError("官方来源请求跳转到未登记域名，已停止采集。");
  const semantic404 = ERROR_PAGE.test(html) || /(?:\/404|\/error)(?:[/?#]|$)/i.test(response.url || "");
  return { ok: response.ok && !semantic404, semantic404, finalUrl: response.url || requestedUrl, html };
}

function primaryUrls(source) {
  return [...new Set([source.collectionEntryUrl || source.entryUrl, ...(source.alternateEntryUrls || [])].filter(Boolean))];
}

export async function collectOfficialNoticeFeed({ source, fetchImpl = fetch, detailLimit = 30 } = {}) {
  if (!source?.id || !source.entryUrl) throw new OfficialNoticeFeedError("官方公告采集缺少来源登记。");
  const domains = officialDomains(source);
  const urls = primaryUrls(source);
  const attemptsRequired = Math.max(["critical", "active"].includes(source.tier) ? 3 : 1, urls.length);
  const accessEvidence = [];
  let page;

  for (let index = 0; index < attemptsRequired && !page; index += 1) {
    const requestedUrl = urls[index % urls.length];
    try {
      const result = await fetchOfficialPage(requestedUrl, domains, fetchImpl);
      if (result.ok) {
        page = { ...result, requestedUrl };
        accessEvidence.push({ requestedUrl, finalUrl: result.finalUrl, outcome: "official-page", recipe: "已读取官方公告/招聘页，抽取同域招聘链接后逐页检查。" });
      } else if (result.semantic404) {
        accessEvidence.push({ requestedUrl, outcome: "semantic-404", recipe: "官方入口返回明确的不存在或错误页。" });
      } else {
        accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: "官方入口未返回可用页面。" });
      }
    } catch (error) {
      accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `官方入口本轮无法读取：${error?.name || "fetch-error"}。` });
    }
  }

  if (!page) {
    return {
      sourceId: source.id,
      collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: accessEvidence.some((item) => item.outcome === "semantic-404") ? "semantic-404" : "temporarily-unavailable",
      accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: "本轮未取得可读取的官方公告/招聘页，不能据此判断无岗位。"
    };
  }

  const anchors = extractAnchors(page.html, page.finalUrl, domains);
  // A source such as the central-enterprise roster is intentionally a source
  // registry, not a job board.  Reading it still verifies the official
  // organisation universe but cannot create a position lead on its own.
  if (source.id === "central-enterprise-roster") {
    return {
      sourceId: source.id, collectionMethod: "official-roster-refresh",
      collectionRoute: "国务院国资委官方中央企业名录页 → 名录变更核对",
      status: "checked-roster-current", accessEvidence, attempts: accessEvidence.length,
      collected: 1, afterFilter: 0, noticeItems: [],
      reason: "已读取官方中央企业名录页；名录用于限定重点单位范围，不把名录本身当作招聘岗位。"
    };
  }
  if (!anchors.length) {
    return {
      sourceId: source.id, collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: "accessible-incomplete", accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: "已读取官方入口，但没有在静态正文中找到可安全跟进的同域招聘列表；该来源需要按登记的浏览器路线继续处理，不能按 0 条理解。"
    };
  }

  const selected = anchors.slice(0, detailLimit);
  const noticeItems = [];
  for (const anchor of selected) {
    try {
      const detail = await fetchOfficialPage(anchor.url, domains, fetchImpl);
      if (!detail.ok) continue;
      const detailText = normalizeText(detail.html);
      // This is a notice-level relevance filter.  It deliberately remains
      // broad: a selected notice can still contain a later position table.
      if (RECRUITMENT_LINK.test(detailText)) {
        noticeItems.push({ title: anchor.title, url: detail.finalUrl, biomedicalRelated: BIOMEDICAL_CONTEXT.test(`${anchor.title} ${detailText}`) });
      }
    } catch { /* a single detail failure does not erase other public notices */ }
  }
  if (!noticeItems.length) {
    return {
      sourceId: source.id, collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: "accessible-incomplete", accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: "已发现招聘导航或链接，但没有取得可核验的同域招聘公告正文；可能跳转到独立招聘系统或动态列表，需要按登记的浏览器路线继续处理，不能按 0 条理解。"
    };
  }
  const relevant = noticeItems.filter((item) => item.biomedicalRelated).length;
  return {
    sourceId: source.id,
    collectionMethod: "official-notice-feed",
    collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
    status: "checked-official-notice-feed", accessEvidence, attempts: accessEvidence.length,
    collected: noticeItems.length, afterFilter: relevant, noticeItems,
    reason: `已读取 ${noticeItems.length} 条同域招聘/公告正文，其中 ${relevant} 条出现生物医学、医疗健康或医药器械相关公开上下文；公告尚未具备具体岗位字段时不发布为岗位。`
  };
}
