/**
 * Shared credential-dir blocklist used by every sandbox backend (macOS
 * seatbelt, Linux bubblewrap). Centralized so the platforms don't drift —
 * earlier the bwrap profile included `~/.config/anthropic` + `~/.gnupg`
 * while the seatbelt profile didn't. Centralizing closes that gap.
 */

/**
 * Cross-platform credential paths to blackhole. Relative to homedir; backends
 * format the absolute path. `Library/Keychains` is macOS-only but keeping it
 * here is harmless on Linux (the path won't exist; `--tmpfs` no-ops).
 */
export const CREDENTIAL_DIR_RELATIVE_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  'Library/Keychains',
  '.config/gcloud',
  '.config/anthropic', // claude-code config
  '.gnupg',
] as const

/** Build the absolute paths of credential dirs to deny under `homedir`. */
export function credentialDirs(homedir: string): string[] {
  return CREDENTIAL_DIR_RELATIVE_PATHS.map(rel => `${homedir}/${rel}`)
}
