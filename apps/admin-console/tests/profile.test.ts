import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileService, safePhotoUrl, type DirectoryPerson, type PeopleLookup } from "../src/server/profile";
import { A, MemCache, code, harness, ok } from "./helpers";

const GOOD = "https://lh3.googleusercontent.com/a/ACg8ocAbC123=s100";

function person(email: string, over: Partial<DirectoryPerson> = {}): DirectoryPerson {
  return { emailAddresses: [{ value: email }], names: [{ displayName: "Ana Souza", metadata: { primary: true } }], photos: [{ url: GOOD, default: false, metadata: { primary: true } }], ...over };
}

class FakePeople implements PeopleLookup {
  calls: string[] = [];
  constructor(private readonly result: DirectoryPerson[] | Error) {}
  searchDirectory(email: string): DirectoryPerson[] {
    this.calls.push(email);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("photo urls", () => {
  it("accepts https images served by Google and asks for an avatar-sized one", () => {
    expect(safePhotoUrl(GOOD)).toBe("https://lh3.googleusercontent.com/a/ACg8ocAbC123=s128-c");
    expect(safePhotoUrl("https://lh3.googleusercontent.com/a/x=s64-c")).toBe("https://lh3.googleusercontent.com/a/x=s128-c");
    expect(safePhotoUrl("https://lh3.ggpht.com/abc")).toBe("https://lh3.ggpht.com/abc");
  });

  it.each([
    ["http (not https)", "http://lh3.googleusercontent.com/a/x"],
    ["another host", "https://evil.example.com/a.png"],
    ["lookalike host", "https://googleusercontent.com.evil.example/a.png"],
    ["credentials in the url", "https://user:pw@lh3.googleusercontent.com/a/x"],
    ["custom port", "https://lh3.googleusercontent.com:8443/a/x"],
    ["javascript url", "javascript:alert(1)"],
    ["data url", "data:image/png;base64,AAAA"],
    ["quote that could break out of an attribute", 'https://lh3.googleusercontent.com/a/x"onerror="alert(1)'],
    ["whitespace", "https://lh3.googleusercontent.com/a/ x"],
    ["not a string", 42],
    ["too long", `https://lh3.googleusercontent.com/${"a".repeat(700)}`],
  ])("rejects %s", (_n, url) => {
    expect(safePhotoUrl(url)).toBeNull();
  });
});

describe("profile lookup", () => {
  it("returns the name and photo of the signed-in user", () => {
    const svc = new ProfileService(new FakePeople([person("ana@example.com")]), new MemCache());
    expect(svc.resolve("ana@example.com")).toEqual({ name: "Ana Souza", photo_url: "https://lh3.googleusercontent.com/a/ACg8ocAbC123=s128-c" });
  });

  it("matches the e-mail exactly: a fuzzy directory hit never lends somebody else's name or photo", () => {
    const svc = new ProfileService(new FakePeople([person("ana.souza@example.com"), person("ana2@example.com")]), new MemCache());
    expect(svc.resolve("ana@example.com")).toEqual({ name: null, photo_url: null });
  });

  it("a default avatar means there is no photo (initials stay), but the name is kept", () => {
    const svc = new ProfileService(new FakePeople([person("ana@example.com", { photos: [{ url: GOOD, default: true }] })]), new MemCache());
    expect(svc.resolve("ana@example.com")).toEqual({ name: "Ana Souza", photo_url: null });
  });

  it("drops a photo that is not served by Google", () => {
    const svc = new ProfileService(new FakePeople([person("ana@example.com", { photos: [{ url: "https://evil.example.com/a.png", default: false }] })]), new MemCache());
    expect(svc.resolve("ana@example.com").photo_url).toBeNull();
  });

  it("never throws: a disabled API, missing consent or hidden directory just means no profile", () => {
    const svc = new ProfileService(new FakePeople(new Error("Request had insufficient authentication scopes. SECRET")), new MemCache());
    expect(svc.resolve("ana@example.com")).toEqual({ name: null, photo_url: null });
  });

  it("is optional: without a lookup there is no profile and nothing is called", () => {
    expect(new ProfileService(undefined, new MemCache()).resolve("ana@example.com")).toEqual({ name: null, photo_url: null });
  });

  it("caches the result (including a miss) so the directory is not hit on every page load", () => {
    const people = new FakePeople([person("ana@example.com")]);
    const svc = new ProfileService(people, new MemCache());
    svc.resolve("ana@example.com");
    svc.resolve("ana@example.com");
    expect(people.calls).toHaveLength(1);
    const miss = new FakePeople([]);
    const svc2 = new ProfileService(miss, new MemCache());
    svc2.resolve("x@example.com");
    svc2.resolve("x@example.com");
    expect(miss.calls).toHaveLength(1);
  });

  it("a corrupt cache entry is discarded instead of breaking sign-in", () => {
    const cache = new MemCache();
    cache.put("prof:ana@example.com", "{not json", 60);
    const svc = new ProfileService(new FakePeople([person("ana@example.com")]), cache);
    expect(svc.resolve("ana@example.com").name).toBe("Ana Souza");
  });
});

describe("the `me` call", () => {
  it("returns the profile of the Google session, whatever the request asks for", () => {
    const people = new FakePeople([person("ana@example.com")]);
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] }, { people });
    const data = ok(h.call("me", { email: "boss@example.com", actor: "boss@example.com", tenant: A })) as { email: string; profile: { name: string } };
    expect(data.email).toBe("ana@example.com");
    expect(data.profile.name).toBe("Ana Souza");
    expect(people.calls).toEqual(["ana@example.com"]); // nothing in the payload can choose whose profile is looked up
  });

  it("still signs the user in when the lookup fails", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] }, { people: new FakePeople(new Error("boom")) });
    expect(code(h.call("me"))).toBe("OK");
    expect((ok(h.call("me")) as { profile: unknown }).profile).toEqual({ name: null, photo_url: null });
  });

  it("does not leak the lookup error to the client or the logs", () => {
    const h = harness({ "ana@example.com": [[A, "VIEWER"]] }, { people: new FakePeople(new Error("insufficient scopes for ana@example.com")) });
    expect(JSON.stringify(h.call("me"))).not.toContain("insufficient scopes");
  });
});

describe("client", () => {
  const appJs = readFileSync(new URL("../src/client/app.js", import.meta.url), "utf8");

  it("checks the photo host again, never sends a referrer, and falls back to the initials when the image fails", () => {
    expect(appJs).toMatch(/var PHOTO_URL = \/\^https:/);
    expect(appJs).toContain("googleusercontent");
    expect(appJs).toContain('referrerpolicy: "no-referrer"');
    expect(appJs).toMatch(/onerror: function \(\) \{ if \(img\.parentNode\)/);
  });

  it("builds the image with createElement (no markup strings): the url is only ever an attribute value", () => {
    expect(appJs).not.toMatch(/\.(?:inner|outer)HTML\s*=|insertAdjacentHTML/);
    expect(appJs).toMatch(/h\("img", \{ src: prof\.photo_url/);
  });
});
