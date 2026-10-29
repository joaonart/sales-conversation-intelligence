import type { Cache } from "./auth";

/** The signed-in user's Workspace directory profile. Display data only: it never grants access and is never used for authorisation. */
export interface Profile {
  name: string | null;
  photo_url: string | null;
}

export interface DirectoryPerson {
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  photos?: Array<{ url?: string; default?: boolean; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
}

/** Everything the server needs from the People API. Tests use a fake. */
export interface PeopleLookup {
  searchDirectory(email: string): DirectoryPerson[];
}

export const NO_PROFILE: Profile = { name: null, photo_url: null };
const PHOTO_HOST = /^(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ggpht\.com)$/i;
const POSITIVE_TTL_SECONDS = 6 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 10 * 60;

/** Only https images served by Google are ever sent to the browser. Anything else is dropped (the UI falls back to initials). */
export function safePhotoUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 600 || /[\s<>"'\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !PHOTO_HOST.test(url.hostname)) return null;
  // Ask for a size suited to the 56px avatar (2x for sharp screens) instead of whatever the directory defaults to.
  return url.href.replace(/=s\d+(-c)?$/, "=s128-c");
}

function pick<T extends { metadata?: { primary?: boolean } }>(items: T[] | undefined): T | undefined {
  return items?.find((i) => i.metadata?.primary) ?? items?.[0];
}

export class ProfileService {
  constructor(
    private readonly people: PeopleLookup | undefined,
    private readonly cache: Cache,
  ) {}

  /** Never throws: a profile is a nicety, and a missing scope, disabled API or hidden directory must not stop anyone from signing in. */
  resolve(email: string): Profile {
    if (!this.people) return NO_PROFILE;
    const key = `prof:${email}`;
    const cached = this.cache.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as Profile;
      } catch {
        this.cache.remove(key);
      }
    }
    let profile = NO_PROFILE;
    let ttl = NEGATIVE_TTL_SECONDS;
    try {
      // Exact match on the e-mail: a directory search is fuzzy and must never attach somebody else's name or photo.
      const person = this.people.searchDirectory(email).find((p) => p.emailAddresses?.some((e) => (e.value ?? "").toLowerCase() === email));
      if (person) {
        const photo = pick(person.photos?.filter((p) => !p.default)); // a default avatar means "no photo": keep the initials
        const name = pick(person.names)?.displayName?.trim().slice(0, 120) || null;
        profile = { name, photo_url: safePhotoUrl(photo?.url) };
        ttl = POSITIVE_TTL_SECONDS;
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "profile_lookup_failed", errorType: e instanceof Error ? e.name : typeof e }));
    }
    this.cache.put(key, JSON.stringify(profile), ttl);
    return profile;
  }
}

/** People API advanced service. Searches the domain directory (executes as the deployer, which is why it looks the user up by e-mail). */
export class AppsScriptPeople implements PeopleLookup {
  searchDirectory(email: string): DirectoryPerson[] {
    const res = People.People!.searchDirectoryPeople({
      query: email,
      readMask: "names,photos,emailAddresses",
      sources: ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
      pageSize: 5,
    });
    return (res.people ?? []) as DirectoryPerson[];
  }
}
