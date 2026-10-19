// CI checks for changesets, run on pull requests:
//   every published package the PR changes is named in a changeset it adds (an empty changeset opts out)
//   every pending changeset is a short tl;dr: at most two sentences and 45 words, no em dashes
// usage: bun .github/scripts/check-changesets.ts <base ref>
import { parseChangesetFile } from "@changesets/parse"
import { $ } from "bun"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
$.cwd(root)

/** packages that reach a registry, by changeset name, with the directory their shipped files live in */
export const PUBLISHED: Record<string, string> = {
  hyperfly: "packages/hyperfly",
  "@hyperfly/python": "python",
  "@hyperfly/rust": "rust",
}

const MAX_WORDS = 45
const MAX_SENTENCES = 2

/** files that never change what a registry ships */
const unshipped = (file: string) =>
  /(^|\/)(tests?|benches|fuzz)\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)CHANGELOG\.md$/.test(file)

/** the published packages a set of changed files touches */
export function touchedPackages(files: string[]): string[] {
  const touched = new Set<string>()
  for (const file of files) {
    if (unshipped(file)) continue
    for (const [name, dir] of Object.entries(PUBLISHED)) if (file.startsWith(`${dir}/`)) touched.add(name)
  }
  return [...touched].sort()
}

export type Changeset = { packages: string[]; body: string }

/** the package names and the summary of a changeset file, read by Changesets' own parser */
export function parseChangeset(text: string): Changeset {
  const { releases, summary } = parseChangesetFile(text)
  return { packages: releases.map(release => release.name), body: summary.trim() }
}

/** what is wrong with a changeset body, if anything */
export function bodyProblems(body: string): string[] {
  const problems: string[] = []
  const words = body.split(/\s+/).filter(Boolean).length
  if (words > MAX_WORDS) problems.push(`${words} words, over the ${MAX_WORDS}-word limit`)
  // a sentence ends at . ! or ? followed by whitespace or the end, so `a.b` in code is not a boundary
  const sentences = body.split(/[.!?](?=\s|$)/).filter(part => part.trim()).length
  if (sentences > MAX_SENTENCES) problems.push(`${sentences} sentences, over the ${MAX_SENTENCES}-sentence limit`)
  if (body.includes("—")) problems.push("contains an em dash")
  return problems
}

/** the packages a PR changes that none of its added changesets names; an added empty changeset covers everything */
export function missingChangesets(touched: string[], added: Changeset[]): string[] {
  if (added.some(changeset => changeset.packages.length === 0)) return []
  const named = new Set(added.flatMap(changeset => changeset.packages))
  return touched.filter(name => !named.has(name))
}

const isChangeset = (file: string) => /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md"

if (import.meta.main) {
  const base = Bun.argv[2]
  if (!base) {
    console.error("usage: bun .github/scripts/check-changesets.ts <base ref>")
    process.exit(2)
  }
  const errors: string[] = []

  for (const file of (await readdir(join(root, ".changeset"))).map(name => `.changeset/${name}`).filter(isChangeset)) {
    try {
      const { packages, body } = parseChangeset(await Bun.file(join(root, file)).text())
      for (const name of packages) if (!(name in PUBLISHED)) errors.push(`${file}: ${name} is not a published package (${Object.keys(PUBLISHED).join(", ")})`)
      for (const problem of bodyProblems(body)) errors.push(`${file}: ${problem}; a changeset is a one or two sentence tl;dr (AGENTS.md)`)
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : error}`)
    }
  }

  const changed = (await $`git diff --name-only --no-renames ${`${base}...HEAD`}`.text()).split("\n").filter(Boolean)
  const added = (await $`git diff --name-only --diff-filter=A ${`${base}...HEAD`}`.text()).split("\n").filter(isChangeset)
  const addedChangesets = await Promise.all(added.map(async file => parseChangeset(await Bun.file(join(root, file)).text())))
  const missing = missingChangesets(touchedPackages(changed), addedChangesets)
  if (missing.length) {
    errors.push(`this PR changes ${missing.join(", ")} without a changeset naming ${missing.length === 1 ? "it" : "them"}: run \`bun changeset\`, or \`bun changeset --empty\` when nothing user-facing changed`)
  }

  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exit(1)
  }
  console.log("changesets ok")
}
