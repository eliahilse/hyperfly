import { describe, expect, test } from "bun:test"
import { changelogSection, distTag, needsRelease, publishedCommit, pythonDists, releaseFlags, repositoryMatches, vcsInfoCommit, withGitHead } from "./release"

const sha = "0123456789abcdef0123456789abcdef01234567"

test("a published version missing its tag or its GitHub release still has release work", () => {
  expect(needsRelease({ published: false, tagged: false, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: false, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: true, released: false })).toBe(true)
  expect(needsRelease({ published: true, tagged: true, released: true })).toBe(false)
})

test("prereleases publish under next, never latest", () => {
  expect(distTag("1.0.0-alpha.0")).toBe("next")
  expect(distTag("1.0.0-rc.2")).toBe("next")
  expect(distTag("1.0.0")).toBe("latest")
})

test("only prereleases get prerelease GitHub release flags", () => {
  expect(releaseFlags("1.0.0")).toEqual([])
  expect(releaseFlags("1.0.0-alpha.1")).toEqual(["--prerelease", "--latest=false"])
})

test("the packed manifest records the commit as gitHead and keeps every other field", () => {
  const original = `${JSON.stringify({ name: "hyperfly", version: "1.2.3", exports: { ".": "./dist/index.js" } }, null, 2)}\n`
  expect(JSON.parse(withGitHead(original, sha))).toEqual({ name: "hyperfly", version: "1.2.3", exports: { ".": "./dist/index.js" }, gitHead: sha })
  expect(JSON.parse(withGitHead(withGitHead(original, "f".repeat(40)), sha)).gitHead).toBe(sha)
})

test("the commit comes from cargo's .cargo_vcs_info.json", () => {
  expect(vcsInfoCommit(JSON.stringify({ git: { sha1: sha }, path_in_vcs: "rust" }))).toBe(sha)
  expect(vcsInfoCommit(JSON.stringify({ path_in_vcs: "rust" }))).toBeUndefined()
  expect(vcsInfoCommit("not json")).toBeUndefined()
})

test("a version with no recorded commit is never tagged on a guess", () => {
  expect(publishedCommit("hyperfly@1.2.3", sha, "npm's gitHead")).toBe(sha)
  for (const missing of [undefined, "", "HEAD", sha.slice(0, 12)]) {
    expect(() => publishedCommit("hyperfly@1.2.3", missing, "npm's gitHead")).toThrow("hyperfly@1.2.3: npm's gitHead names no commit")
  }
})

test("PyPI file names use the normalized distribution name", () => {
  expect(pythonDists("hyperfly", "1.0.0a1")).toEqual(["hyperfly-1.0.0a1-py3-none-any.whl", "hyperfly-1.0.0a1.tar.gz"])
  expect(pythonDists("Hyperfly.Py-Core", "2.0.0")).toEqual(["hyperfly_py_core-2.0.0-py3-none-any.whl", "hyperfly_py_core-2.0.0.tar.gz"])
})

test("provenance needs the manifest to name this repository", () => {
  expect(repositoryMatches({ type: "git", url: "https://github.com/eliahilse/hyperfly" })).toBe(true)
  expect(repositoryMatches("git+https://github.com/eliahilse/hyperfly.git")).toBe(true)
  expect(repositoryMatches({ url: "https://github.com/eliahilse/hyperfly-fork" })).toBe(false)
  expect(repositoryMatches({ url: "https://github.com/someone/hyperfly" })).toBe(false)
  expect(repositoryMatches(undefined)).toBe(false)
})

describe("changelogSection", () => {
  const changelog = "# hyperfly\n\n## 1.0.0-alpha.2\n\n### Patch Changes\n\n- Faster.\n\n## 1.0.0-alpha.1\n\n### Minor Changes\n\n- Adds `x`.\n"
  test("returns one version's section", () => {
    expect(changelogSection(changelog, "1.0.0-alpha.2")).toBe("### Patch Changes\n\n- Faster.")
    expect(changelogSection(changelog, "1.0.0-alpha.1")).toBe("### Minor Changes\n\n- Adds `x`.")
  })
  test("returns undefined for a missing or empty section", () => {
    expect(changelogSection(changelog, "1.0.0")).toBeUndefined()
    expect(changelogSection("## 1.0.0\n\n## 0.9.0\n- x\n", "1.0.0")).toBeUndefined()
  })
})
