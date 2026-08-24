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

test("识别政府列表中的 javascript:checkUrl 公告链接", async () => {
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url) => {
      if (String(url).endsWith("recruitment.html")) return response({
        url: String(url),
        html: `<a href="javascript:checkUrl('https://notice.example.gov.cn/recruit/2027.html')">2027年度事业单位招聘公告</a>`
      });
      return response({ url: String(url), html: "<div>招聘岗位及报名条件</div>" });
    }
  });
  assert.equal(result.status, "checked-official-notice-feed");
  assert.equal(result.noticeItems[0].url, "https://notice.example.gov.cn/recruit/2027.html");
});

test("跟随官方页面中的脚本跳转后再解析公告", async () => {
  const calls = [];
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("recruitment.html")) return response({
        url: String(url),
        html: `<script>window.location = "/recruit/index.html";</script>`
      });
      if (String(url).endsWith("/recruit/index.html")) return response({
        url: String(url),
        html: `<a href="/recruit/notice.html">校园招聘公告</a>`
      });
      return response({ url: String(url), html: "<div>应届毕业生招聘岗位</div>" });
    }
  });
  assert.equal(result.status, "checked-official-notice-feed");
  assert.equal(calls.length, 3);
});

test("官方列表直链到政府站或公众号时保留公告线索但不冒充岗位", async () => {
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url) => response({
      url: String(url),
      html: `<a href="https://mp.weixin.qq.com/s/official-notice">校园招聘公告</a>`
    })
  });
  assert.equal(result.status, "checked-official-notice-feed");
  assert.equal(result.noticeItems.length, 1);
  assert.match(result.noticeItems[0].evidence, /不据此发布具体岗位/);
});

test("公开政府页面返回计算型 Cookie 挑战时脚本自动完成一次握手", async () => {
  let entranceCalls = 0;
  const result = await collectOfficialNoticeFeed({
    source,
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith("recruitment.html")) {
        entranceCalls += 1;
        if (entranceCalls === 1) return response({
          url: String(url),
          html: `<script>var e={WTKkN:1,bOYDu:2,wyeCN:3};t=a(t,4);continue;case"4";EO_Bot_Ssid</script>`
        });
        assert.equal(options.headers.cookie, "__tst_status=6#; EO_Bot_Ssid=4");
        return response({ url: String(url), html: `<a href="/notice.html">事业单位招聘公告</a>` });
      }
      return response({ url: String(url), html: "<div>公开招聘岗位及报名条件</div>" });
    }
  });
  assert.equal(result.status, "checked-official-notice-feed");
  assert.equal(entranceCalls, 2);
});
