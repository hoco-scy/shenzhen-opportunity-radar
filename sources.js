const sourceState = { filter: "全部", query: "", registry: null, reviewLog: null };

const escapeHTML = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const allowedHttpHosts = new Set(["bm.scs.gov.cn", "subb.scs.gov.cn", "job.mohrss.gov.cn", "wap.sasac.gov.cn", "www.spacetalent.com.cn"]);
const safeUrl = (value = "") => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && allowedHttpHosts.has(url.hostname)) return url.href;
    return "#";
  } catch { return "#"; }
};

const formatDateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value)).replaceAll("/", ".") : "未记录";

const roleLabels = {
  authoritative: "官方发布依据",
  roster: "官方名录",
  discovery: "发现线索",
};

const cadenceLabels = {
  "every-run": "重点关注",
};

function statusPresentation(status) {
  if (!status || status.startsWith("checked")) return { label: "持续关注", className: "checked" };
  if (status === "accessible-incomplete") return { label: "信息待确认", className: "incomplete" };
  if (status === "temporarily-unavailable" || status === "semantic-404") return { label: "等待更新", className: "waiting" };
  return { label: "持续关注", className: "checked" };
}

function latestChecks() {
  const checks = new Map();
  for (const run of sourceState.reviewLog.runs || []) {
    for (const check of run.sourceChecks || []) {
      if (!checks.has(check.sourceId)) checks.set(check.sourceId, check);
    }
  }
  return checks;
}

function filteredSources() {
  const keyword = sourceState.query.trim().toLowerCase();
  return sourceState.registry.sources.filter((source) => {
    const coverage = source.coverage || [];
    const matchesFilter = sourceState.filter === "全部" || coverage.includes(sourceState.filter);
    const haystack = [source.organization, source.type, ...coverage, ...(source.domains || [])].join(" ").toLowerCase();
    return matchesFilter && (!keyword || haystack.includes(keyword));
  });
}

function renderSources() {
  const grid = document.querySelector("#source-grid");
  const resultCount = document.querySelector("#source-result-count");
  const checks = latestChecks();
  const sources = filteredSources();
  resultCount.textContent = `${sources.length} 个信息源`;

  if (!sources.length) {
    grid.innerHTML = '<div class="empty-state"><strong>没有找到对应的信息源</strong><p>换一个分类或关键词试试。</p></div>';
    return;
  }

  grid.innerHTML = sources.map((source) => {
    const check = checks.get(source.id);
    const status = statusPresentation(check?.status);
    const coverage = (source.coverage || []).filter((item) => item !== "发现线索");
    const tags = coverage.map((item) => `<span>${escapeHTML(item)}</span>`).join("");
    const checkedAt = check?.checkedAt ? `最近更新 ${formatDateTime(check.checkedAt)}`
      : sourceState.reviewLog.meta.initializationStatus === "awaiting-first-sync" ? "等待首次完整更新" : "持续关注招聘信息";
    return `<article class="source-directory-card role-${escapeHTML(source.role)}">
      <div class="source-card-topline"><span class="source-role">${escapeHTML(roleLabels[source.role] || source.type)}</span><span class="source-health ${status.className}">${status.label}</span></div>
      <h3>${escapeHTML(source.organization)}</h3>
      <p class="source-type">${escapeHTML(source.type)} · ${escapeHTML(cadenceLabels[source.cadence] || source.cadence)}</p>
      <div class="source-coverage"><strong>覆盖</strong>${tags || "<span>综合信息</span>"}</div>
      <div class="source-card-footer"><span>${escapeHTML(checkedAt)}</span><a href="${safeUrl(source.entryUrl)}" target="_blank" rel="noreferrer">打开官网 ↗</a></div>
    </article>`;
  }).join("");
}

function bindSourceFilters() {
  document.querySelectorAll("[data-source-filter]").forEach((button) => button.addEventListener("click", () => {
    sourceState.filter = button.dataset.sourceFilter;
    document.querySelectorAll("[data-source-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderSources();
  }));
  document.querySelector("#source-search").addEventListener("input", (event) => {
    sourceState.query = event.target.value;
    renderSources();
  });
}

async function initSources() {
  try {
    const [registryResponse, reviewResponse] = await Promise.all([
      fetch("data/source-registry.json", { cache: "no-store" }),
      fetch("data/review-log.json", { cache: "no-store" }),
    ]);
    if (!registryResponse.ok || !reviewResponse.ok) throw new Error("信息源数据读取失败");
    [sourceState.registry, sourceState.reviewLog] = await Promise.all([registryResponse.json(), reviewResponse.json()]);
    document.querySelector("#sync-date").innerHTML = sourceState.reviewLog.meta.initializationStatus === "awaiting-first-sync"
      ? `<i></i>等待首次完整更新`
      : `<i></i>最近更新：${formatDateTime(sourceState.reviewLog.meta.lastRunAt)}`;
    bindSourceFilters();
    renderSources();
  } catch (error) {
    document.querySelector("#source-grid").innerHTML = '<div class="empty-state"><strong>信息源暂时没有加载出来</strong><p>请稍后刷新页面。</p></div>';
    console.error("Failed to load sources", error);
  }
}

initSources();
