// Release steps for .github/workflows/release.yml.
//   npm-preflight    public packages whose version is not on npm: build, pack, check, npm publish --dry-run
//   npm-publish      the same packages: pack, publish with provenance, then tag and create a GitHub release
//   pypi-preflight   python/ when its sdist or wheel is not on PyPI: build both into python/dist, twine check
//   pypi-tag         before the PyPI upload: tag this commit, since PyPI records no commit to tag later
//   pypi-release     after the PyPI upload: confirm both files are visible, then create the GitHub release
//   crates-preflight rust/ when its version is not on crates.io: cargo publish --dry-run
//   crates-publish   the same crate: cargo publish, then tag and create a GitHub release
//   changesets       whether .changeset holds a changeset that releases something (empty ones release nothing)
// Steps write their results to $GITHUB_OUTPUT. A version is pending while it is unpublished, untagged or without its
// GitHub release, so a rerun finishes what an earlier run left. Tags go on the commit the registry says the version
// was built from (npm's gitHead, the crate's .cargo_vcs_info.json); PyPI versions are tagged before they upload.
import { $ } from "bun"
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseChangeset } from "./check-changesets"
import { pep440, tomlString } from "./sync-versions"

const root = join(import.meta.dir, "../..")
$.cwd(root)

const REPOSITORY = "eliahilse/hyperfly"
const USER_AGENT = `hyperfly-release (github.com/${REPOSITORY})`

/** a version still has release work: unpublished, or published without its tag or its GitHub release */
export const needsRelease = (state: { published: boolean; tagged: boolean; released: boolean }) => !state.published || !state.tagged || !state.released

/** package.json text with the commit it is packed from as gitHead, which npm keeps in the registry's metadata */
export function withGitHead(packageJson: string, commit: string): string {
  return `${JSON.stringify({ ...JSON.parse(packageJson), gitHead: commit }, null, 2)}\n`
}

/** the commit cargo recorded in a .crate's .cargo_vcs_info.json */
export function vcsInfoCommit(text: string): string | undefined {
  try {
    const sha = JSON.parse(text)?.git?.sha1
    return typeof sha === "string" ? sha : undefined
  } catch {
    return undefined
  }
}

/** a full commit sha, or an error saying how to tag by hand: never a guess */
export function publishedCommit(tag: string, commit: string | undefined, source: string): string {
  if (commit && /^[0-9a-f]{40}$/.test(commit)) return commit
  throw new Error(`${tag}: ${source} names no commit, so its tag cannot be placed; tag the commit it was published from by hand: git tag ${tag} <sha> && git push origin refs/tags/${tag}`)
}

export const prerelease = (version: string) => version.includes("-")

/** npm's dist-tag for a version: prereleases never move `latest` */
export const distTag = (version: string) => (prerelease(version) ? "next" : "latest")

/** the body of a CHANGELOG.md section for one version, or undefined when there is none */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n")
  const start = lines.findIndex(line => line.trim() === `## ${version}`)
  if (start < 0) return undefined
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() || undefined
}

/** the sdist and wheel file names for a pure-Python distribution (PEP 625 and PEP 427 normalize the name) */
export function pythonDists(name: string, version: string): string[] {
  const normalized = name.toLowerCase().replace(/[-_.]+/g, "_")
  return [`${normalized}-${version}-py3-none-any.whl`, `${normalized}-${version}.tar.gz`].sort()
}

/** provenance needs the packed manifest to name this repository */
export function repositoryMatches(repository: unknown): boolean {
  const url = typeof repository === "string" ? repository : (repository as { url?: unknown } | undefined)?.url
  return typeof url === "string" && new RegExp(`^(git\\+)?https://github\\.com/${REPOSITORY}(\\.git)?$`).test(url)
}

const head = async () => (await $`git rev-parse HEAD`.quiet().text()).trim()

async function output(key: string, value: string) {
  if (Bun.env.GITHUB_OUTPUT) await appendFile(Bun.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  console.log(`${key}=${value}`)
}

async function summary(line: string) {
  if (Bun.env.GITHUB_STEP_SUMMARY) await appendFile(Bun.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  console.log(line)
}

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`${what} failed (attempt ${attempt}), retrying: ${error instanceof Error ? error.message : error}`)
      await Bun.sleep(5_000 * attempt)
    }
  }
}

/** a registry URL that answers 200 for a published version and 404 otherwise */
async function exists(what: string, url: string) {
  return retry(what, async () => {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } })
    if (response.status === 200) return true
    if (response.status === 404) return false
    throw new Error(`${url} answered ${response.status}`)
  })
}

async function tagged(tag: string) {
  return (await $`git ls-remote --tags origin ${`refs/tags/${tag}`}`.quiet().text()).trim() !== ""
}

async function released(tag: string) {
  return retry(`gh release view ${tag}`, async () => {
    const view = await $`gh release view ${tag} --json tagName`.quiet().nothrow()
    if (view.exitCode === 0) return true
    if (/release not found/i.test(view.stderr.toString())) return false
    throw new Error(view.stderr.toString().trim() || `gh release view exited ${view.exitCode}`)
  })
}

/** whether a published version still needs its tag or GitHub release */
async function unfinished(tag: string) {
  return !(await tagged(tag)) || !(await released(tag))
}

/** release notes from a package's CHANGELOG.md section for its (semver) version */
async function notes(dir: string, version: string, tag: string) {
  const file = Bun.file(join(root, dir, "CHANGELOG.md"))
  return ((await file.exists()) && changelogSection(await file.text(), version)) || tag
}

/** tags the commit the version was published from (looked up only when the tag is missing) and creates its GitHub release */
async function tagAndRelease(tag: string, commit: () => Promise<string>, version: string, body: string) {
  if (!(await tagged(tag))) {
    await $`git tag ${tag} ${await commit()}`
    await $`git push origin ${`refs/tags/${tag}`}`
  }
  if (await released(tag)) return
  const flags = prerelease(version) ? ["--prerelease", "--latest=false"] : []
  await $`gh release create ${tag} --title ${tag} --notes ${body} --verify-tag ${flags}`
}

// npm

type Pkg = { dir: string; name: string; version: string; isNew: boolean; published: boolean }

/** "published", "free" (the package exists, this version doesn't) or "new" (no such package) */
async function npmState(name: string, version: string) {
  return retry(`npm view ${name}`, async () => {
    const view = await $`npm view ${`${name}@${version}`} version --prefer-online`.quiet().nothrow()
    if (view.exitCode === 0 && view.stdout.toString().trim()) return "published"
    if (view.exitCode !== 0 && !/E404/.test(view.stderr.toString())) throw new Error(view.stderr.toString().trim() || `npm view exited ${view.exitCode}`)
    const pkg = await $`npm view ${name} name --prefer-online`.quiet().nothrow()
    if (pkg.exitCode === 0 && pkg.stdout.toString().trim()) return "free"
    if (pkg.exitCode !== 0 && /E404/.test(pkg.stderr.toString())) return "new"
    throw new Error(pkg.stderr.toString().trim() || `npm view exited ${pkg.exitCode}`)
  })
}

async function pendingPackages(): Promise<Pkg[]> {
  const pending: Pkg[] = []
  for await (const file of new Bun.Glob("packages/*/package.json").scan({ cwd: root })) {
    const pkg = await Bun.file(join(root, file)).json()
    if (pkg.private) continue
    const state = await npmState(pkg.name, pkg.version)
    const entry = { dir: dirname(file), name: pkg.name, version: pkg.version, isNew: state === "new", published: state === "published" }
    if (!entry.published || (await unfinished(`${pkg.name}@${pkg.version}`))) pending.push(entry)
  }
  return pending.sort((a, b) => a.name.localeCompare(b.name))
}

/** builds with turbo and packs with bun, which rewrites workspace: ranges; the manifest records this commit as gitHead */
async function pack(pkg: Pkg, commit: string) {
  await $`bunx turbo run build --filter=${pkg.name}`
  const out = await mkdtemp(join(tmpdir(), "hyperfly-pack-"))
  const dir = join(root, pkg.dir)
  const manifestFile = join(dir, "package.json")
  const original = await Bun.file(manifestFile).text()
  await Bun.write(manifestFile, withGitHead(original, commit))
  try {
    await $`bun pm pack --destination ${out}`.cwd(dir)
  } finally {
    await Bun.write(manifestFile, original)
  }
  const tarballs = (await readdir(out)).filter(file => file.endsWith(".tgz"))
  if (tarballs.length !== 1) throw new Error(`${pkg.name}: expected one tarball, found ${tarballs.length}`)
  const tarball = join(out, tarballs[0]!)
  const manifest = JSON.parse(await $`tar -xOzf ${tarball} package/package.json`.text())
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error(`${pkg.name}: packed ${manifest.name}@${manifest.version}`)
  if (manifest.gitHead !== commit) throw new Error(`${pkg.name}: the packed package.json does not record gitHead ${commit}`)
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${pkg.name}: the packed package.json still has workspace: ranges`)
  if (!repositoryMatches(manifest.repository)) throw new Error(`${pkg.name}: repository must point at github.com/${REPOSITORY} for provenance`)
  return tarball
}

async function npmPreflight() {
  const pending = await pendingPackages()
  const commit = await head()
  for (const pkg of pending) {
    if (pkg.published) {
      await summary(`- npm: ${pkg.name}@${pkg.version} is published but its tag or GitHub release is missing`)
      continue
    }
    const tarball = await pack(pkg, commit)
    await $`npm publish ${tarball} --dry-run --access public --tag ${distTag(pkg.version)}`
    await summary(`- npm: ${pkg.name}@${pkg.version} ready (dist-tag ${distTag(pkg.version)})${pkg.isNew ? "; new package: configure its trusted publisher first" : ""}`)
  }
  if (!pending.length) await summary("- npm: nothing to publish")
  await output("npm", String(pending.length))
}

async function npmPublish() {
  const pending = await pendingPackages()
  const toPublish = pending.filter(pkg => !pkg.published)
  const commit = await head()
  const tarballs = new Map<string, string>()
  for (const pkg of toPublish) tarballs.set(pkg.name, await pack(pkg, commit))
  // published by this run, so from this commit; anything else is looked up on npm
  const ours = new Set<string>()
  for (const pkg of toPublish) {
    await retry(`publish ${pkg.name}`, async () => {
      const publish = await $`npm publish ${tarballs.get(pkg.name)!} --access public --provenance --tag ${distTag(pkg.version)}`.nothrow()
      // the version was unpublished when this run started and runs never overlap, so if it is there now it is ours
      if (publish.exitCode === 0 || (await npmState(pkg.name, pkg.version)) === "published") ours.add(pkg.name)
      else throw new Error(`npm publish exited ${publish.exitCode}`)
    })
    await summary(`- npm: published ${pkg.name}@${pkg.version} (dist-tag ${distTag(pkg.version)})`)
  }
  for (const pkg of pending) {
    const tag = `${pkg.name}@${pkg.version}`
    const npmCommit = async () => {
      const gitHead = await retry(`npm view ${tag} gitHead`, () => $`npm view ${tag} gitHead --prefer-online`.quiet().text())
      return publishedCommit(tag, gitHead.trim(), "npm's gitHead")
    }
    // npm can take minutes to show a new version, so a version this run published is tagged without waiting for it
    await tagAndRelease(tag, async () => (ours.has(pkg.name) ? commit : npmCommit()), pkg.version, await notes(pkg.dir, pkg.version, tag))
  }
  if (!pending.length) await summary("- npm: nothing to publish")
}

// PyPI

const PYTHON_DIR = "python"

async function pythonRelease() {
  const { version } = await Bun.file(join(root, PYTHON_DIR, "package.json")).json()
  const pyproject = await Bun.file(join(root, PYTHON_DIR, "pyproject.toml")).text()
  const name = tomlString(pyproject, "project", "name")
  const pyVersion = tomlString(pyproject, "project", "version")
  if (pyVersion !== pep440(version)) throw new Error(`python/pyproject.toml is at ${pyVersion}, python/package.json at ${version}: run bun .github/scripts/sync-versions.ts`)
  return { name, version, pyVersion, tag: `${name}-python@${pyVersion}` }
}

/** the files PyPI has for a version, empty when the version does not exist */
async function pypiFiles(name: string, version: string): Promise<string[]> {
  return retry(`PyPI ${name} ${version}`, async () => {
    const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`, { headers: { "user-agent": USER_AGENT } })
    if (response.status === 404) return []
    if (response.status !== 200) throw new Error(`pypi.org answered ${response.status}`)
    const { urls } = (await response.json()) as { urls: { filename: string }[] }
    return urls.map(url => url.filename)
  })
}

async function pypiState() {
  const release = await pythonRelease()
  const present = await pypiFiles(release.name, release.pyVersion)
  const missing = pythonDists(release.name, release.pyVersion).filter(file => !present.includes(file))
  return { ...release, missing, pending: missing.length > 0 || (await unfinished(release.tag)) }
}

/** the commit a tag points at, or undefined when there is no such tag on origin */
async function tagCommit(tag: string) {
  const line = (await $`git ls-remote --tags origin ${`refs/tags/${tag}`} ${`refs/tags/${tag}^{}`}`.quiet().text()).trim().split("\n")
  const peeled = line.find(entry => entry.endsWith("^{}")) ?? line[0]
  return peeled ? peeled.split(/\s/)[0] : undefined
}

async function pypiPreflight() {
  const state = await pypiState()
  if (state.missing.length) {
    const dist = join(root, PYTHON_DIR, "dist")
    await rm(dist, { recursive: true, force: true })
    await $`python -m build --sdist --wheel --outdir ${dist} ${join(root, PYTHON_DIR)}`
    const built = (await readdir(dist)).sort()
    const expected = pythonDists(state.name, state.pyVersion)
    if (JSON.stringify(built) !== JSON.stringify(expected)) throw new Error(`python/dist has ${built.join(", ")}, expected ${expected.join(", ")}`)
    await $`twine check --strict ${built.map(file => join(dist, file))}`
    await summary(`- PyPI: ${state.name} ${state.pyVersion} ready (${state.missing.join(", ")})`)
  } else if (state.pending) {
    await summary(`- PyPI: ${state.name} ${state.pyVersion} is published but its GitHub release is missing`)
  } else {
    await summary("- PyPI: nothing to publish")
  }
  await output("pypi", state.pending ? "1" : "0")
  await output("upload", state.missing.length ? "true" : "false")
}

async function pypiTag() {
  const state = await pypiState()
  const commit = await head()
  const tagged = await tagCommit(state.tag)
  if (tagged === undefined) {
    await $`git tag ${state.tag} ${commit}`
    await $`git push origin ${`refs/tags/${state.tag}`}`
  } else if (tagged !== commit && state.missing.length) {
    // an earlier upload from that commit stopped part way; uploading this commit's files would mix two builds
    throw new Error(`${state.tag} is on ${tagged}, but PyPI lacks ${state.missing.join(", ")}: re-run the release run for ${tagged}, or delete the tag if nothing from it reached PyPI`)
  }
}

async function pypiRelease() {
  const state = await pypiState()
  await retry(`confirm ${state.name} ${state.pyVersion}`, async () => {
    const present = await pypiFiles(state.name, state.pyVersion)
    const missing = pythonDists(state.name, state.pyVersion).filter(file => !present.includes(file))
    if (missing.length) throw new Error(`PyPI does not show ${missing.join(", ")} yet`)
  }, 10)
  await tagAndRelease(state.tag, async () => publishedCommit(state.tag, undefined, "PyPI"), state.version, await notes(PYTHON_DIR, state.version, state.tag))
  await summary(`- PyPI: published ${state.name} ${state.pyVersion} (${state.tag})`)
}

// crates.io

const RUST_MANIFEST = "rust/Cargo.toml"

type Crate = { name: string; version: string; published: boolean }

async function rustCrate(): Promise<Crate> {
  const metadata = JSON.parse(await $`cargo metadata --manifest-path ${RUST_MANIFEST} --no-deps --format-version 1 --locked`.quiet().text())
  // publish = false shows as an empty list; null means any registry
  const crates = metadata.packages.filter((pkg: { publish: string[] | null }) => pkg.publish === null || pkg.publish.includes("crates-io"))
  if (crates.length !== 1) throw new Error(`${RUST_MANIFEST}: expected one publishable crate, found ${crates.length}`)
  const { name, version } = crates[0]
  const manifest = await Bun.file(join(root, "rust/package.json")).json()
  if (manifest.version !== version) throw new Error(`${RUST_MANIFEST} is at ${version}, rust/package.json at ${manifest.version}: run bun .github/scripts/sync-versions.ts`)
  return { name, version, published: await exists(`crates.io ${name}`, `https://crates.io/api/v1/crates/${name}/${version}`) }
}

/** the commit cargo recorded in the published .crate */
async function crateCommit(crate: Crate, tag: string) {
  const file = join(await mkdtemp(join(tmpdir(), "hyperfly-crate-")), `${crate.name}-${crate.version}.crate`)
  await retry(`download ${tag}`, async () => {
    const response = await fetch(`https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`, { headers: { "user-agent": USER_AGENT } })
    if (!response.ok) throw new Error(`static.crates.io answered ${response.status}`)
    await Bun.write(file, response)
  })
  const info = await $`tar -xOzf ${file} ${`${crate.name}-${crate.version}/.cargo_vcs_info.json`}`.quiet().nothrow()
  return publishedCommit(tag, info.exitCode === 0 ? vcsInfoCommit(info.stdout.toString()) : undefined, "the crate's .cargo_vcs_info.json")
}

async function cratesPreflight() {
  const crate = await rustCrate()
  const tag = `${crate.name}@${crate.version}`
  const pending = !crate.published || (await unfinished(tag))
  if (pending && !crate.published) {
    await $`cargo publish --dry-run --locked --manifest-path ${RUST_MANIFEST}`
    await summary(`- crates: ${tag} ready`)
  } else if (pending) {
    await summary(`- crates: ${tag} is published but its tag or GitHub release is missing`)
  } else {
    await summary("- crates: nothing to publish")
  }
  await output("crates", pending ? "1" : "0")
  await output("upload", crate.published ? "false" : "true")
}

async function cratesPublish() {
  const crate = await rustCrate()
  const tag = `${crate.name}@${crate.version}`
  if (crate.published && !(await unfinished(tag))) return summary("- crates: nothing to publish")
  const commit = await head()
  let ours = false
  if (!crate.published) {
    if (!Bun.env.CARGO_REGISTRY_TOKEN) throw new Error("CARGO_REGISTRY_TOKEN is unset")
    // cargo waits until the version is available on the index before it returns
    await $`cargo publish --locked --manifest-path ${RUST_MANIFEST}`
    ours = true
    await summary(`- crates: published ${tag}`)
  }
  await tagAndRelease(tag, async () => (ours ? commit : crateCommit(crate, tag)), crate.version, await notes("rust", crate.version, tag))
}

async function changesets() {
  const files = (await readdir(join(root, ".changeset"))).filter(file => file.endsWith(".md") && file !== "README.md")
  const releasing = []
  for (const file of files) if (parseChangeset(await Bun.file(join(root, ".changeset", file)).text()).packages.length) releasing.push(file)
  await summary(releasing.length ? `- changesets to release: ${releasing.join(", ")}` : "- no changesets to release")
  await output("pending", releasing.length ? "true" : "false")
}

const steps: Record<string, () => Promise<unknown>> = {
  changesets,
  "npm-preflight": npmPreflight,
  "npm-publish": npmPublish,
  "pypi-preflight": pypiPreflight,
  "pypi-tag": pypiTag,
  "pypi-release": pypiRelease,
  "crates-preflight": cratesPreflight,
  "crates-publish": cratesPublish,
}

if (import.meta.main) {
  const step = steps[Bun.argv[2] ?? ""]
  if (!step) {
    console.error(`usage: bun .github/scripts/release.ts <${Object.keys(steps).join("|")}>`)
    process.exit(2)
  }
  await step()
}
