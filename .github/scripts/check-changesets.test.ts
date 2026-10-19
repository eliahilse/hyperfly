import { describe, expect, test } from "bun:test"
import { bodyProblems, missingChangesets, parseChangeset, touchedPackages } from "./check-changesets"

describe("touchedPackages", () => {
  test("maps shipped files to their package", () => {
    expect(touchedPackages(["packages/hyperfly/src/index.ts", "rust/src/lib.rs", "python/pyproject.toml", "README.md"])).toEqual(["@hyperfly/python", "@hyperfly/rust", "hyperfly"])
  })
  test("ignores tests, benches, fuzzing and changelogs", () => {
    expect(
      touchedPackages([
        "packages/hyperfly/test/codec.test.ts",
        "packages/hyperfly/src/codec.test.ts",
        "python/tests/test_http.py",
        "rust/tests/vectors.rs",
        "rust/fuzz/fuzz_targets/decode.rs",
        "packages/hyperfly/CHANGELOG.md",
      ]),
    ).toEqual([])
  })
  test("ignores unpublished workspaces", () => expect(touchedPackages(["packages/lb/src/index.ts", "apps/web/app/page.tsx", "packages/hyperfly-extra/x.ts"])).toEqual([]))
})

describe("parseChangeset", () => {
  test("reads quoted and bare package names", () => {
    expect(parseChangeset(`---\n"hyperfly": minor\n'@hyperfly/rust': patch\n@hyperfly/python: major\n---\n\nAdds \`encodeStream\`.\n`)).toEqual({
      packages: ["hyperfly", "@hyperfly/rust", "@hyperfly/python"],
      body: "Adds `encodeStream`.",
    })
  })
  test("reads an empty changeset", () => expect(parseChangeset("---\n---\n")).toEqual({ packages: [], body: "" }))
  test("rejects a file without frontmatter", () => {
    expect(() => parseChangeset("Adds a thing.\n")).toThrow("missing frontmatter")
    expect(() => parseChangeset("---\nhyperfly: patch\n")).toThrow("unterminated")
  })
})

describe("bodyProblems", () => {
  test("accepts one or two sentences", () => {
    expect(bodyProblems("Adds `Codec.encodeStream`, which writes frames to a stream.")).toEqual([])
    expect(bodyProblems("Decoding rejects truncated varints. Errors name the byte offset.")).toEqual([])
  })
  test("does not split on dots inside code", () => expect(bodyProblems("Adds `hyperfly/http.negotiate` and `a.b.c`. Faster.")).toEqual([]))
  test("rejects three sentences, long bodies and em dashes", () => {
    expect(bodyProblems("One. Two. Three.")).toEqual(["3 sentences, over the 2-sentence limit"])
    expect(bodyProblems(Array(46).fill("word").join(" "))).toEqual(["46 words, over the 45-word limit"])
    expect(bodyProblems("Faster — much faster.")).toEqual(["contains an em dash"])
  })
})

describe("missingChangesets", () => {
  test("requires every touched package to be named", () => {
    expect(missingChangesets(["@hyperfly/rust", "hyperfly"], [{ packages: ["hyperfly"], body: "x" }])).toEqual(["@hyperfly/rust"])
    expect(missingChangesets(["hyperfly"], [])).toEqual(["hyperfly"])
  })
  test("an empty changeset opts the PR out", () => expect(missingChangesets(["hyperfly"], [{ packages: [], body: "" }])).toEqual([]))
})
