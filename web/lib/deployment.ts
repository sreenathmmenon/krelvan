/**
 * The public website is a product site, not a shared Krelvan workspace.
 * Self-hosted installations leave this unset and retain setup/sign-in.
 */
export const MARKETING_ONLY =
  process.env["NEXT_PUBLIC_KRELVAN_MARKETING_ONLY"] === "1";
