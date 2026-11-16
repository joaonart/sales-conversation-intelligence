/**
 * The page a person sees when Google let them in but the console cannot identify them (no account, or one outside the company domain). It is the only
 * screen the server draws itself, before any script of the console exists, so it is plain HTML with its own small stylesheet: no script, no font, no image
 * and no address from outside except the one button, which is built by `accountChooserUrl` from the web app's own address.
 *
 * Every text is a constant written in the code (or the allowed domain, escaped); nothing from a request or an error reaches this page.
 */
export interface GateOptions {
  title: string;
  message: string;
  /** A smaller line under the message. */
  hint?: string;
  /** The button: a label and the address it goes to (only ever the Google account chooser, built by the caller). */
  action?: { label: string; href: string };
  version?: string;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/* The same colours as the console (light and dark, following the system), so the person already feels at home. */
const CSS = `
:root{color-scheme:light dark;--bg:#f5f7fa;--surface:#fff;--fg:#171c26;--muted:#566074;--line:#dde2ea;--primary:#1a6fe6;--primary-hover:#1459bd;--on-primary:#fff;--soft:#e6f0fd}
@media (prefers-color-scheme:dark){:root{--bg:#11141a;--surface:#191d25;--fg:#e8ebf1;--muted:#9ba5b5;--line:#2d3440;--primary:#7eaaf8;--primary-hover:#a3c2fb;--on-primary:#0f1722;--soft:#26364f}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:14px/20px Inter,"Google Sans Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{position:relative;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2.5rem 1rem;overflow:hidden}
.glow{position:absolute;border-radius:9999px;background:var(--soft);filter:blur(64px);pointer-events:none}
.glow.a{top:-8rem;left:-6rem;width:24rem;height:24rem}.glow.b{bottom:-9rem;right:-7rem;width:22rem;height:22rem;opacity:.7}
main{position:relative;width:100%;max-width:28rem;background:var(--surface);border:1px solid var(--line);border-radius:.875rem;padding:2rem;box-shadow:0 8px 24px rgb(23 28 38/.14),0 2px 6px rgb(23 28 38/.08)}
.brand{display:flex;align-items:center;gap:.75rem;margin-bottom:1.75rem;font-weight:600;font-size:1rem}
.mark{display:inline-flex;width:2rem;height:2rem;align-items:center;justify-content:center;border-radius:.5rem;background:var(--primary);color:var(--on-primary);font-weight:700}
.lock{display:flex;width:3rem;height:3rem;align-items:center;justify-content:center;margin-bottom:1rem;border-radius:9999px;background:var(--soft);color:var(--primary)}
h1{margin:0 0 .5rem;font-size:1.5rem;line-height:2rem;font-weight:600;letter-spacing:-.01em}
p{margin:0 0 1rem;color:var(--muted)}p.hint{font-size:12px;margin-bottom:0}
a.btn{display:inline-flex;height:2.5rem;align-items:center;justify-content:center;margin:.25rem 0 1.25rem;padding:0 1.25rem;border-radius:.625rem;background:var(--primary);color:var(--on-primary);font-weight:600;text-decoration:none}
a.btn:hover{background:var(--primary-hover)}a.btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
footer{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
`;

const LOCK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

export function gateHtml(o: GateOptions): string {
  const button = o.action ? `<a class="btn" href="${escapeHtml(o.action.href)}" target="_top" rel="noopener">${escapeHtml(o.action.label)}</a>` : "";
  return (
    `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">` +
    `<title>${escapeHtml(o.title)}</title><style>${CSS}</style></head><body><div class="glow a" aria-hidden="true"></div><div class="glow b" aria-hidden="true"></div>` +
    `<main><div class="brand"><span class="mark" aria-hidden="true">S</span><span>SCI Console</span></div><div class="lock">${LOCK}</div>` +
    `<h1>${escapeHtml(o.title)}</h1><p>${escapeHtml(o.message)}</p>${button}${o.hint ? `<p class="hint">${escapeHtml(o.hint)}</p>` : ""}` +
    `<footer>O acesso é restrito a contas Google autorizadas${o.version ? ` · v${escapeHtml(o.version)}` : ""}</footer></main></body></html>`
  );
}
