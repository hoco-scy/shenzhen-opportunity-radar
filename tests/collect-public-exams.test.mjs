import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import {
  collectBeijingCivil,
  collectGuangdongCivil,
  collectNationalCivil,
  collectPublicExam,
  collectShanghaiCivil,
  diffSnapshots,
  extractApplicationLifecycle,
  parseNationalCoreConstants,
  parsePositionWorkbook
} from "../scripts/collect-public-exams.mjs";

function json(value) {
  return JSON.stringify(value);
}

function mockFetch(routes) {
  return async (input) => {
    const key = String(input);
    const response = routes[key];
    if (!response) throw new Error(`unexpected request: ${key}`);
    if (response instanceof Error) throw response;
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: response.headers ?? { "content-type": typeof response.body === "string" ? "text/html" : "application/octet-stream" }
    });
  };
}

function workbookBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["招录机关", "职位名称", "职位代码", "工作地点", "专业要求", "学历要求"],
    ["广州市某局", "医疗器械监管", "1001", "广州市", "生物医学工程", "硕士研究生"],
    ["深圳市某局", "医疗器械监管", "1002", "深圳市", "生物医学工程", "硕士研究生"]
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "职位表");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

test("parses the stateful national SPA configuration instead of guessing a yearly URL", () => {
  const parsed = parseNationalCoreConstants('neu.hb01Id = "topic-2027"; neu.cdnServer = "http://dl.scs.gov.cn";');
  assert.equal(parsed.topicId, "topic-2027");
  assert.equal(parsed.apiOrigin, "http://dl.scs.gov.cn");
});

test("recognizes closed registration ranges even when a government CMS splits date digits across spans", () => {
  const lifecycle = extractApplicationLifecycle(
    "<p>报名时间为 <span>202</span><span>6</span>年5月8日8:00至10日18:00。</p>",
    new Date("2026-08-23T00:00:00+08:00")
  );
  assert.equal(lifecycle.status, "expired");
  assert.equal(lifecycle.deadline, "2026-05-10");
});

test("recognizes a future cross-month registration deadline", () => {
  const lifecycle = extractApplicationLifecycle(
    "网上报名：2099年10月20日至11月5日。",
    new Date("2026-08-23T00:00:00+08:00")
  );
  assert.equal(lifecycle.status, "open-or-upcoming");
  assert.equal(lifecycle.deadline, "2099-11-05");
});

test("uses the registration window rather than a later graduation deadline in the same announcement", () => {
  const lifecycle = extractApplicationLifecycle(
    "报名时间为2025年12月4日9:00至8日16:00；报考者最高学历毕业证书应于2026年9月30日前取得。",
    new Date("2026-08-23T00:00:00+08:00"),
    { title: "广东省2026年度选调优秀大学毕业生公告" }
  );
  assert.equal(lifecycle.status, "expired");
  assert.equal(lifecycle.deadline, "2025-12-08");
});

test("collects national notices from the official public JSON path and keeps an official attachment", async () => {
  const main = "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/home/gkhome.html";
  const supplemental = "http://subb.scs.gov.cn/pp/gkweb/core/web/ui/business/home/lxhome.html";
  const constant = "http://dl.scs.gov.cn/core-constant.js";
  const feed = "http://dl.scs.gov.cn/api/gkhome/article/topic-2027";
  const detail = "http://dl.scs.gov.cn/api/article/a1";
  const fetchImpl = mockFetch({
    [main]: { body: '<script src="http://dl.scs.gov.cn/core-constant.js"></script>' },
    [supplemental]: { body: '<script src="http://dl.scs.gov.cn/core-constant.js"></script>' },
    [constant]: { body: 'neu.hb01Id = "topic-2027"; neu.cdnServer = "http://dl.scs.gov.cn";' },
    [feed]: { body: json({ articleGroupList: [{ title: "招考公告", articleList: [{ id: "a1", articleTitle: "中央机关及其直属机构2027年度考试录用公务员公告", pstrtime: "2026-10-14" }] }] }) },
    [detail]: { body: json({ article: { articleTitle: "中央机关及其直属机构2027年度考试录用公务员公告", content: '<a href="/download/position.xlsx">职位表</a>' }, resourceList: [] }) }
  });
  const result = await collectNationalCivil({ fetchImpl });
  assert.equal(result.collectionMethod, "script");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].attachments[0].officialUrl, "http://dl.scs.gov.cn/download/position.xlsx");
  assert.equal(result.status, "completed");
});

test("collects Beijing static notices and discovers its attached position table", async () => {
  const entry = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/";
  const notice = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/202610/t20261015_1.html";
  const fetchImpl = mockFetch({
    [entry]: { body: `<a href="./202610/t20261015_1.html" title="北京市各级机关2027年度考试录用公务员公告">公告</a><span>2026-10-15</span>` },
    [notice]: { body: '<a href="./position.xlsx">附件1：职位表</a>' }
  });
  const result = await collectBeijingCivil({ fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "recruitment-announcement");
  assert.equal(result.notices[0].attachments[0].officialUrl, "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/202610/position.xlsx");
});

test("collects Shanghai notices through the official API hierarchy", async () => {
  const sections = "https://shacs.gov.cn/gwyj/api/gwy-column-section.json?listChild=true";
  const news = "https://shacs.gov.cn/gwyj/api/child-section-and-news.json?sectionId=407&pageSize=2000";
  const detail = "https://shacs.gov.cn/gwyj/api/show-news.json?id=1284";
  const fetchImpl = mockFetch({
    [sections]: { body: json({ state: "SUCCESS", result: { child: [{ id: 407, name: "上海市2027年度考试录用公务员专题" }] } }) },
    [news]: { body: json({ state: "SUCCESS", result: { secNews: { list: [{ id: 1284, title: "上海市2027年度考试录用公务员公告", postDate: "2026-11-01" }] } } }) },
    [detail]: { body: json({ state: "SUCCESS", result: { title: "上海市2027年度考试录用公务员公告", postDate: "2026-11-01", content: '<a href="/files/position.xlsx">职位表</a>' } }) }
  });
  const result = await collectShanghaiCivil({ fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].sectionName, "上海市2027年度考试录用公务员专题");
  assert.equal(result.notices[0].attachments[0].officialUrl, "https://shacs.gov.cn/files/position.xlsx");
});

test("parses a Guangzhou-filtered official position workbook without asking a browser to open each job", () => {
  const sheets = parsePositionWorkbook(workbookBuffer(), { city: "广州市", fileName: "职位表.xlsx" });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].totalRows, 2);
  assert.equal(sheets[0].cityFilteredRows.length, 1);
  assert.equal(sheets[0].cityFilteredRows[0].positionCode, "1001");
});

test("collects Guangdong notices and parses only Guangzhou rows from a public ZIP attachment", async () => {
  const entry = "https://www.gdzz.gov.cn/gwygz/lypytzgg/index.html";
  const notice = "https://www.gdzz.gov.cn/gwygz/lypytzgg/content/post_30000.html";
  const archiveUrl = "https://www.gdzz.gov.cn/public/2027-position.zip";
  const archive = new AdmZip();
  archive.addFile("广东省2027年考试录用公务员职位表.xlsx", workbookBuffer());
  const fetchImpl = mockFetch({
    [entry]: { body: `<a href="/gwygz/lypytzgg/content/post_30000.html" title="广东省2027年考试录用公务员公告">公告</a><span>2026-10-19</span>` },
    [notice]: { body: '<a href="/public/2027-position.zip">点击查看：附件1-5</a>' },
    [archiveUrl]: { body: archive.toBuffer(), headers: { "content-type": "application/zip" } }
  });
  const direct = await collectGuangdongCivil({ sourceId: "guangzhou-civil", fetchImpl });
  assert.equal(direct.noticeCount, 1);
  const result = await collectPublicExam({ sourceId: "guangzhou-civil", fetchImpl, parseTables: true });
  assert.equal(result.positionTables.tables.length, 1);
  assert.equal(result.positionTables.tables[0].files[0].sheets[0].cityFilteredRows.length, 1);
  assert.equal(result.positionTables.tables[0].files[0].sheets[0].cityFilteredRows[0].location, "广州市");
});

test("snapshot diff reports new and changed notices without writing public jobs", () => {
  const previous = { notices: { a: { title: "旧公告", officialUrl: "https://example.invalid/a", fingerprint: "old" } } };
  const next = { notices: {
    a: { title: "旧公告修订", officialUrl: "https://example.invalid/a", fingerprint: "new" },
    b: { title: "新公告", officialUrl: "https://example.invalid/b", fingerprint: "fresh" }
  } };
  assert.deepEqual(diffSnapshots(previous, next).map((item) => item.change).sort(), ["changed", "new"]);
});
