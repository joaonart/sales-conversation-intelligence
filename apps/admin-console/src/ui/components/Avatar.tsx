import { useState } from "preact/hooks";
import { cx } from "../lib/cx";
import type { Profile } from "../lib/types";

/** The server already allows only Google-hosted https images; the browser checks again (defence in depth). */
const PHOTO_URL = /^https:\/\/(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ggpht\.com)\/[^\s<>"'\\]*$/i;

export function initials(email: string): string {
  const n = (email.split("@")[0] ?? "?").split(/[._-]+/).filter(Boolean);
  return (((n[0] ?? "?")[0] ?? "?") + (n[1]?.[0] ?? "")).toUpperCase();
}

interface AvatarProps {
  email: string;
  profile: Profile;
  large?: boolean;
}

/** The directory photo when there is a usable one, the initials otherwise (also when the image fails to load). */
export function Avatar({ email, profile, large }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const photo = !broken && typeof profile.photo_url === "string" && PHOTO_URL.test(profile.photo_url) ? profile.photo_url : null;
  return (
    <span aria-hidden="true" class={cx("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-soft font-semibold text-on-primary-soft", large ? "size-14 text-lg" : "size-8 text-xs")}>
      {initials(email)}
      {photo ? <img src={photo} alt="" referrerpolicy="no-referrer" decoding="async" class="absolute inset-0 size-full object-cover" onError={() => setBroken(true)} /> : null}
    </span>
  );
}
