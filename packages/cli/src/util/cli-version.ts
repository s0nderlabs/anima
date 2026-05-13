/**
 * Resolve the CLI package's own version. Used to pin the gateway version
 * installed in sandbox containers (mode=npm) so the gateway matches the CLI.
 *
 * Uses `import.meta.resolve` so it works in every install layout: monorepo
 * workspace, `bun add -g` global install, Bun's per-project content store.
 */
export async function resolveCliVersion(): Promise<string> {
  try {
    const pkgUrl = import.meta.resolve('@s0nderlabs/anima/package.json')
    const { default: pkg } = (await import(pkgUrl, { with: { type: 'json' } })) as {
      default: { version: string }
    }
    return pkg.version
  } catch (e) {
    throw new Error(
      `cannot resolve @s0nderlabs/anima/package.json for CLI version (npm mode requires this): ${(e as Error).message}`,
    )
  }
}
