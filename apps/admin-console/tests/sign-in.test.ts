import { describe, expect, it } from "vitest";
import { APP_URL, accountChooserUrl, isAppUrl, logoutUrl } from "../src/server/appUrl";
import { loadConfig, type PropertyReader } from "../src/server/config";
import { gateHtml } from "../src/server/gatePage";
import { AppError } from "../src/server/errors";
import { A, harness, ok } from "./helpers";

const OK = "https://script.google.com/a/macros/j-nart.com/s/AKfycbyV-abc_123/exec";
const props = (extra: Record<string, string> = {}): PropertyReader => {
  const all: Record<string, string> = { GCP_PROJECT: "proj-123456", ALLOWED_DOMAIN: "example.com", ...extra };
  return { getProperty: (k) => all[k] ?? null };
};

describe("the web app's address and the Google pages built from it", () => {
  it("accepts only the address of an Apps Script web app (a domain deployment, a plain one, /exec or /dev)", () => {
    for (const good of [OK, "https://script.google.com/macros/s/AKfy123/exec", "https://script.google.com/macros/s/AKfy123/dev"]) expect(isAppUrl(good), good).toBe(true);
    for (const bad of ["http://script.google.com/macros/s/AKfy123/exec", "https://evil.example/exec", "https://script.google.com.evil.example/macros/s/AK/exec",
      "https://script.google.com/macros/s/AK/exec?x=1", "javascript:alert(1)", "", null, undefined, 42]) expect(isAppUrl(bad), String(bad)).toBe(false);
    expect(APP_URL.test(`${OK}\n`)).toBe(false);
  });

  it("the account chooser and the sign-out come back to the console, or open without a way back when the address is not valid", () => {
    expect(accountChooserUrl(OK)).toBe(`https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(OK)}`);
    expect(logoutUrl(OK)).toBe(`https://accounts.google.com/Logout?continue=${encodeURIComponent(OK)}`);
    for (const bad of ["https://evil.example/exec", "javascript:alert(1)", null, undefined]) {
      expect(accountChooserUrl(bad)).toBe("https://accounts.google.com/AccountChooser");
      expect(logoutUrl(bad)).toBe("https://accounts.google.com/Logout");
    }
  });
});

describe("the page for a Google account the console cannot use", () => {
  const html = gateHtml({ title: "Entre com sua conta corporativa", message: "A conta usada não foi reconhecida.", hint: "Escolha a corporativa.", action: { label: "Escolher conta Google", href: accountChooserUrl(OK) }, version: "0.58.0" });

  it("is a whole page with the title, the message, the hint, one button to the account chooser and the version", () => {
    expect(html).toMatch(/^<!DOCTYPE html><html lang="pt-BR">/);
    expect(html).toContain("<title>Entre com sua conta corporativa</title>");
    expect(html).toContain("A conta usada não foi reconhecida.");
    expect(html).toContain("Escolha a corporativa.");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${accountChooserUrl(OK).replace(/&/g, "&amp;")}"`);
    expect(html).toContain('target="_top" rel="noopener"');
    expect(html).toContain("· v0.58.0");
  });

  it("runs no script and loads nothing from outside: no script, no font, no image, no frame; the only address is the button's", () => {
    expect(html).not.toMatch(/<script|<iframe|<img|<link|@import|url\(|\son[a-z]+\s*=/i); // (no inline event handlers either)
    expect(html.match(/https?:\/\//g)?.length).toBe(1); // the account chooser, in the button
    expect(html).toContain("prefers-color-scheme:dark"); // follows the system theme like the console
    expect(html).toContain('<meta name="viewport"');
  });

  it("escapes every text, even one that carries markup (it never receives any from a request, but it must not be able to)", () => {
    const hostile = gateHtml({ title: '<script>alert(1)</script>"', message: "<img src=x onerror=alert(1)>", hint: "'quoted'", action: { label: "<b>x</b>", href: 'https://a"onmouseover="x' }, version: "<1>" });
    expect(hostile).not.toMatch(/<script>alert|<img src=x|<b>x<\/b>|onmouseover="x/);
    expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;");
    expect(hostile).toContain("&#39;quoted&#39;");
  });

  it("has no button when there is nothing to go to (the console is not configured)", () => {
    const off = gateHtml({ title: "Console indisponível", message: "O console não está configurado." });
    expect(off).not.toContain("<a ");
    expect(off).not.toContain('class="hint"');
  });
});

describe("the contact for access requests", () => {
  it("is optional: none by default", () => {
    expect(loadConfig(props()).accessContact).toBeNull();
    expect(loadConfig(props({ ACCESS_CONTACT_EMAIL: "   " })).accessContact).toBeNull();
  });

  it("is a valid address, lower-cased and trimmed; anything else is a configuration error, never a silent none", () => {
    expect(loadConfig(props({ ACCESS_CONTACT_EMAIL: "  Acesso@Example.com " })).accessContact).toBe("acesso@example.com");
    for (const bad of ["acesso", "a b@example.com", "x@y", "a@@example.com", "javascript:alert(1)@example.com", `${"a".repeat(130)}@example.com`]) {
      expect(() => loadConfig(props({ ACCESS_CONTACT_EMAIL: bad })), bad).toThrow(AppError);
    }
  });

  it("`me` carries it to the screen that asks for access, and null when it is not set", () => {
    const withContact = harness({ "ana@example.com": [[A, "VIEWER"]] }, { cfg: { accessContact: "acesso@example.com" } });
    expect((ok(withContact.call("me")) as { access_contact: unknown }).access_contact).toBe("acesso@example.com");
    expect((ok(harness({ "ana@example.com": [[A, "VIEWER"]] }).call("me")) as { access_contact: unknown }).access_contact).toBeNull();
  });

  it("an account with no row in app_users still gets its `me` (an empty list of workspaces), so the screen can say what to do", () => {
    const h = harness({});
    const data = ok(h.call("me", {}, "nova@example.com")) as { email: string; memberships: unknown[] };
    expect(data.memberships).toEqual([]);
    expect(data.email).toBe("nova@example.com");
  });
});
