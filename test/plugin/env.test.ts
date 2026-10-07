import { describe, expect, it } from "vitest";
import { injectProxyEnv, mergeNoProxy } from "../../src/plugin/env";

describe("mergeNoProxy", () => {
  it("keeps existing entries, appends defaults, dedupes", () => {
    expect(mergeNoProxy("example.com, localhost")).toBe("example.com,localhost,127.0.0.1,::1");
  });

  it("works with undefined and trims empties", () => {
    expect(mergeNoProxy(undefined)).toBe("localhost,127.0.0.1,::1");
    expect(mergeNoProxy("")).toBe("localhost,127.0.0.1,::1");
    expect(mergeNoProxy(" a , ,B , a")).toBe("a,B,localhost,127.0.0.1,::1");
  });
});

describe("injectProxyEnv", () => {
  it("sets all proxy keys + NO_PROXY and restores exactly", () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://old:1", NO_PROXY: "example.com" };
    const h = injectProxyEnv(17891, env);
    expect(h.proxyUrl).toBe("http://127.0.0.1:17891");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:17891");
    expect(env.https_proxy).toBe("http://127.0.0.1:17891");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:17891");
    expect(env.http_proxy).toBe("http://127.0.0.1:17891");
    expect(env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe("example.com,localhost,127.0.0.1,::1");
    h.restore();
    expect(env.HTTPS_PROXY).toBe("http://old:1");
    expect(env.https_proxy).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBe("example.com");
    expect(env.no_proxy).toBeUndefined();
  });
});
