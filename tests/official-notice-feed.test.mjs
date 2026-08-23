import test from "node:test";
import assert from "node:assert/strict";
import { collectOfficialNoticeFeed } from "../scripts/collect-official-notice-feed.mjs";

function response({ url, html, ok = true, status = 200 }) {
  return { url, html: undefined, ok, status, text: async () => html };
}

const source = {
  id: "example-official", entryUrl: "https://jobs.example.gov.cn/recruitment.html",
  domains: ["example.gov.cn"], tier: "priority"
};

test("官方公告采集器读取同域招聘链接和公告正文，而非只探测首页", async () => {
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url) => {
      if (String(url).endsWith("recruitment.html")) return response({ url: String(url), html: '<a href="/notices/1.html">2027届医疗器械校园招聘</a>' });
      if (String(url).endsWith("/notices/1.html")) return response({ url: String(url), html: '<title>2027届医疗器械校园招聘</title><div>面向应届毕业生招聘生物医学工程师</div>' });
      throw new Error(`unexpected request: ${url}`);
    }
  });
  assert.equal(result.status, "checked-official-notice-feed");
  assert.equal(result.collected, 1);
  assert.equal(result.afterFilter, 1);
  assert.equal(result.noticeItems[0].url, "https://jobs.example.gov.cn/notices/1.html");
});

test("只有招聘导航、没有可核验同域正文时明确保留未完成状态", async () => {
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url) => String(url).endsWith("recruitment.html")
      ? response({ url: String(url), html: '<a href="/careers">人才招聘</a>' })
      : response({ url: String(url), html: "<title>系统首页</title><div>普通说明页面</div>" })
  });
  assert.equal(result.status, "accessible-incomplete");
  assert.equal(result.collected, null);
  assert.equal(result.afterFilter, null);
});
