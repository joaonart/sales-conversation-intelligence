/**
 * The web app's own address and the Google pages the console sends a person to. The address always comes from Apps Script (`ScriptApp.getService().getUrl()`),
 * never from a request, and it is checked against the shape of an Apps Script web app before it is put in a link: anything else is dropped, and the Google
 * page is then opened without a return address (it still works, it just does not come back to the console).
 */
export const APP_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)$/;

export const isAppUrl = (u: unknown): u is string => typeof u === "string" && APP_URL.test(u);

const withBack = (base: string, back: unknown): string => (isAppUrl(back) ? `${base}?continue=${encodeURIComponent(back)}` : base);

/** Ends the Google session of this browser and comes back to the console, which then asks to sign in again. */
export const logoutUrl = (back: unknown): string => withBack("https://accounts.google.com/Logout", back);

/** Google's account chooser: pick another account (or add one) and come back to the console. The other signed-in accounts stay signed in. */
export const accountChooserUrl = (back: unknown): string => withBack("https://accounts.google.com/AccountChooser", back);
