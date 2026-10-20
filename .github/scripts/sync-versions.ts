// Changesets versions python/package.json and rust/package.json; this writes those versions into the manifests
// PyPI and crates.io read. `bun .github/scripts/sync-versions.ts` writes them, `--check` fails when they differ.
import { join } from "node:path"

const root = join(import.meta.dir, "../..")

const PEP440_PRE: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" }

/** a semver version as PEP 440: 1.0.0-alpha.1 -> 1.0.0a1; only alpha, beta and rc prereleases have an equivalent */
export function pep440(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-([a-z]+)\.(\d+))?$/.exec(version)
  if (!match) throw new Error(`${version}: expected X.Y.Z or X.Y.Z-<alpha|beta|rc>.N`)
  const [, release, pre, n] = match
  if (pre === undefined) return release!
  const id = PEP440_PRE[pre]
  if (!id) throw new Error(`${version}: prerelease id ${pre} has no PEP 440 equivalent (use alpha, beta or rc)`)
  return `${release}${id}${n}`
}

const eol = (source: string) => (source.includes("\r\n") ? "\r\n" : "\n")

/** the line index of a top-level string key in a TOML table; throws when the table or the key is missing */
function tomlLine(lines: string[], table: string, key: string): number {
  const header = `[${table}]`
  const start = lines.findIndex(line => line.trim() === header)
  if (start < 0) throw new Error(`no ${header} table`)
  for (let i = start + 1; i < lines.length && !lines[i]!.trim().startsWith("["); i++) {
    if (new RegExp(`^${key}\\s*=\\s*"[^"]*"\\s*$`).test(lines[i]!)) return i
  }
  throw new Error(`${header} has no ${key}`)
}

/** a top-level string value of a TOML table */
export function tomlString(source: string, table: string, key: string): string {
  const lines = source.split(eol(source))
  return /"([^"]*)"/.exec(lines[tomlLine(lines, table, key)]!)![1]!
}

/** the version line of a TOML table, replaced; throws when the table or its version is missing */
export function setTomlVersion(source: string, table: string, version: string): string {
  const lines = source.split(eol(source))
  lines[tomlLine(lines, table, "version")] = `version = "${version}"`
  return lines.join(eol(source))
}

/** Cargo.lock with the version of one package replaced */
export function setLockVersion(source: string, name: string, version: string): string {
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\r?\\nversion = ")[^"]+(")`)
  if (!pattern.test(source)) throw new Error(`Cargo.lock has no ${name} package`)
  return source.replace(pattern, `$1${version}$2`)
}

type Target = { file: string; update: (source: string, version: string) => string }

const targets: { manifest: string; files: Target[] }[] = [
  {
    manifest: "python/package.json",
    files: [{ file: "python/pyproject.toml", update: (source, version) => setTomlVersion(source, "project", pep440(version)) }],
  },
  {
    manifest: "rust/package.json",
    files: [
      { file: "rust/Cargo.toml", update: (source, version) => setTomlVersion(source, "package", version) },
      { file: "rust/Cargo.lock", update: (source, version) => setLockVersion(source, "hyperfly-core", version) },
    ],
  },
]

if (import.meta.main) {
  const check = Bun.argv.includes("--check")
  const stale: string[] = []
  for (const { manifest, files } of targets) {
    const { version } = await Bun.file(join(root, manifest)).json()
    for (const { file, update } of files) {
      const path = join(root, file)
      const source = await Bun.file(path).text()
      const updated = update(source, version)
      if (updated === source) continue
      if (check) stale.push(`${file} does not match ${manifest} (${version})`)
      else {
        await Bun.write(path, updated)
        console.log(`${file}: ${version}`)
      }
    }
  }
  if (stale.length) {
    console.error(`${stale.join("\n")}\nrun: bun .github/scripts/sync-versions.ts`)
    process.exit(1)
  }
}
