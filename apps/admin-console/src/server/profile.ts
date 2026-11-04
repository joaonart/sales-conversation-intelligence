import type { Cache } from "./auth";

/** The signed-in user's Workspace directory profile. Display data only: it never grants access and is never used for authorisation. */
export interface Profile {
  name: string | null;
  photo_url: string | null;
}

export interface DirectoryPerson {
  /** `people/<id>`: lets the Google Account profile be read when the directory entry has no photo. */
  resourceName?: string;
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  photos?: Array<{ url?: string; default?: boolean; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
}

/** Everything the server needs from the People API. Tests use a fake. */
export interface PeopleLookup {
  searchDirectory(email: string): DirectoryPerson[];
  /**
   * The person's Google Account profile, by the resourceName the directory returned. The domain profile often has no photo when the user set it in
   * their own Google Account (aboutme / myaccount); that photo is only on the account profile. Optional: without it only the directory is used.
   */
  getPerson?(resourceName: string): DirectoryPerson;
}

const RESOURCE_NAME = /^people\/[A-Za-z0-9_-]{1,64}$/;

/** First usable (non-default, Google-hosted) photo: directory entry first, then the account profile of that same person. */
function photoOf(people: PeopleLookup, person: DirectoryPerson): string | null {
  const direct = safePhotoUrl(pick(person.photos?.filter((p) => !p.default))?.url);
  if (direct || !people.getPerson || !person.resourceName || !RESOURCE_NAME.test(person.resourceName)) return direct;
  const account = people.getPerson(person.resourceName);
  return safePhotoUrl(pick(account.photos?.filter((p) => !p.default))?.url);
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

/** Why a profile has no photo, without any personal data (counts, flags and the image host only). Used by `authorize()` to explain a missing photo. */
export interface ProfileDiagnosis {
  found: number;
  exact_match: boolean;
  names: number;
  photos: number;
  default_photos: number;
  photo_host: string | null;
  photo_accepted: boolean;
  /** Same counts for the Google Account profile fallback (null when it was not consulted). */
  account_photos: number | null;
  account_default_photos: number | null;
  account_photo_accepted: boolean | null;
  account_error: string | null;
}

export function diagnose(people: PeopleLookup, email: string): ProfileDiagnosis {
  const found = people.searchDirectory(email);
  const person = found.find((p) => p.emailAddresses?.some((e) => (e.value ?? "").toLowerCase() === email));
  const photo = pick(person?.photos?.filter((p) => !p.default));
  let host: string | null = null;
  try {
    host = photo?.url ? new URL(photo.url).hostname : null;
  } catch {
    host = null;
  }
  return {
    found: found.length,
    exact_match: Boolean(person),
    names: person?.names?.length ?? 0,
    photos: person?.photos?.length ?? 0,
    default_photos: person?.photos?.filter((p) => p.default).length ?? 0,
    photo_host: host,
    photo_accepted: safePhotoUrl(photo?.url) !== null,
    ...diagnoseAccount(people, person),
  };
}

function diagnoseAccount(people: PeopleLookup, person: DirectoryPerson | undefined): Pick<ProfileDiagnosis, "account_photos" | "account_default_photos" | "account_photo_accepted" | "account_error"> {
  const none = { account_photos: null, account_default_photos: null, account_photo_accepted: null, account_error: null };
  if (!person?.resourceName || !people.getPerson || !RESOURCE_NAME.test(person.resourceName)) return none;
  try {
    const account = people.getPerson(person.resourceName);
    return {
      account_photos: account.photos?.length ?? 0,
      account_default_photos: account.photos?.filter((p) => p.default).length ?? 0,
      account_photo_accepted: safePhotoUrl(pick(account.photos?.filter((p) => !p.default))?.url) !== null,
      account_error: null,
    };
  } catch (e) {
    return { ...none, account_error: e instanceof Error ? e.name : typeof e };
  }
}

export class ProfileService {
  constructor(
    private readonly people: PeopleLookup | undefined,
    private readonly cache: Cache,
  ) {}

  /** Never throws: a profile is a nicety, and a missing scope, disabled API or hidden directory must not stop anyone from signing in. */
  resolve(email: string): Profile {
    if (!this.people) return NO_PROFILE;
    const key = `prof2:${email}`; // v2: entries cached before the account-photo fallback must not hide a photo for hours
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
        const name = pick(person.names)?.displayName?.trim().slice(0, 120) || null;
        let photo_url: string | null = null;
        try {
          photo_url = photoOf(this.people, person); // a default avatar means "no photo": keep the initials
        } catch (e) {
          // The name alone is still worth showing; the photo is retried after the short TTL.
          console.error(JSON.stringify({ event: "profile_photo_lookup_failed", errorType: e instanceof Error ? e.name : typeof e }));
        }
        profile = { name, photo_url };
        // Without a photo, look again soon: a photo the user adds (or a lookup that failed) should show up within minutes, not hours.
        ttl = photo_url ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS;
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

  getPerson(resourceName: string): DirectoryPerson {
    return People.People!.get(resourceName, { personFields: "photos" }) as DirectoryPerson;
  }
}
