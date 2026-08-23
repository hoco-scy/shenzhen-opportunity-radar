import test from "node:test";
import assert from "node:assert/strict";
import { collectBuaaDiscovery } from "../scripts/collect-buaa-discovery.mjs";
import { collectIGuopinDiscovery } from "../scripts/collect-iguopin-discovery.mjs";

function response(data, url, { text } = {}) {
  return { ok: true, status: 200, url, json: async () => data, text: async () => text ?? JSON.stringify(data) };
}

test("北航采集器只用城市和单位性质缩小列表，并在详情中筛出生物医学工程候选", async () => {
  const calls = [];
  const result = await collectBuaaDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: String(init.body || "") });
      if (String(url).endsWith("/init.js")) return response(undefined, String(url), { text: "window.config={token:'public-token'}" });
      if (String(url).endsWith("ajax_frontRecruitinfo")) {
        const fields = new URLSearchParams(init.body);
        assert.equal(fields.get("city"), "110000");
        assert.ok(["31", "23", "20"].includes(fields.get("corporationNature")));
        assert.equal(fields.has("title"), false);
        return response({ state: 1, object: { totalPage: 1, count: 1, list: [{ id: "buaa-1", title: "医疗器械研发工程师" }] } }, String(url));
      }
      if (String(url).endsWith("ajax_show")) return response({ state: 1, object: { recruitmentinfo: {
        id: "buaa-1", title: "医疗器械研发工程师", corporationName: "示例医疗器械公司", education: "硕士",
        majorName: "生物医学工程", startTime: "2099-01-01", endTime: "2099-12-31", isFrontShow: "1",
        recruitmentPositionList: [{ cityName: "北京市", positionName: "研发工程师", positionDescription: "医疗器械研发", majorName: "生物医学工程", studentType: "硕士" }]
      } } }, String(url));
      throw new Error(`unexpected request: ${url}`);
    }
  });
  assert.equal(result.nativeFilterQueries, 3);
  assert.equal(result.deduplicatedCandidates, 1);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].title, "医疗器械研发工程师");
  assert.equal(calls.filter((call) => call.url.endsWith("ajax_frontRecruitinfo")).length, 3);
});

test("国聘采集器使用公开城市关键词分页，并拦截纯算法和社招岗位", async () => {
  const requestedKeywords = [];
  const result = await collectIGuopinDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      assert.equal(String(url), "https://gp-api.iguopin.com/api/jobs/v1/recom-job");
      const payload = JSON.parse(init.body);
      requestedKeywords.push(payload.search.keyword);
      assert.deepEqual(payload.search.district, ["000000.110000"]);
      const job = payload.search.keyword === "医疗器械" ? {
        job_id: "iguopin-1", status: 1, job_name: "医疗器械研发工程师", company_name: "示例医疗器械公司",
        nature_cn: "校招", education_cn: "硕士", experience_cn: "无经验", major_cn: ["生物医学工程"],
        contents: "面向应届毕业生开展医疗器械研发", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : payload.search.keyword === "医疗" ? {
        job_id: "iguopin-cs", status: 1, job_name: "AI算法工程师", company_name: "示例科技公司",
        nature_cn: "校招", education_cn: "硕士", experience_cn: "无经验", major_cn: ["生物医学工程"],
        contents: "面向应届毕业生从事通用大模型训练", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : null;
      return response({ code: 200, data: { total: job ? 1 : 0, list: job ? [job] : [] } }, String(url));
    }
  });
  assert.equal(result.nativeFilterQueries, 6);
  assert.equal(result.deduplicatedCandidates, 2);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].id, "iguopin-1");
  assert.equal(result.detailOutcomes["core-profession-mismatch"], 1);
  assert.equal(new Set(requestedKeywords).size, 6);
});
