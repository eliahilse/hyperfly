import { describe, expect, test } from "bun:test"
import { pep440, setLockVersion, setTomlVersion } from "./sync-versions"

describe("pep440", () => {
  test("keeps a release version", () => expect(pep440("1.2.3")).toBe("1.2.3"))
  test("maps alpha, beta and rc", () => {
    expect(pep440("1.0.0-alpha.0")).toBe("1.0.0a0")
    expect(pep440("1.0.0-alpha.12")).toBe("1.0.0a12")
    expect(pep440("0.1.1-beta.3")).toBe("0.1.1b3")
    expect(pep440("2.0.0-rc.1")).toBe("2.0.0rc1")
  })
  test("rejects prerelease ids PEP 440 cannot express", () => {
    expect(() => pep440("1.0.0-next.0")).toThrow("no PEP 440 equivalent")
    expect(() => pep440("1.0.0-alpha")).toThrow("expected")
    expect(() => pep440("1.0")).toThrow("expected")
  })
})

describe("setTomlVersion", () => {
  const pyproject = `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "hyperfly"\nversion = "1.0.0a0"\n\n[tool.x]\nversion = "9"\n`
  test("replaces only the named table's version", () => {
    expect(setTomlVersion(pyproject, "project", "1.0.0a1")).toBe(pyproject.replace('version = "1.0.0a0"', 'version = "1.0.0a1"'))
  })
  test("is a no-op at the same version", () => expect(setTomlVersion(pyproject, "project", "1.0.0a0")).toBe(pyproject))
  test("throws without the table or its version", () => {
    expect(() => setTomlVersion(pyproject, "package", "1.0.0")).toThrow("no [package] table")
    expect(() => setTomlVersion("[package]\nname = \"x\"\n[deps]\nversion = \"1\"\n", "package", "1.0.0")).toThrow("has no version")
  })
})

describe("setLockVersion", () => {
  const lock = `[[package]]\nname = "hyperfly-core"\nversion = "0.1.0"\ndependencies = [\n "sha2",\n]\n\n[[package]]\nname = "sha2"\nversion = "0.10.9"\n`
  test("replaces the named package's version", () => {
    expect(setLockVersion(lock, "hyperfly-core", "0.1.1-alpha.0")).toBe(lock.replace('"0.1.0"', '"0.1.1-alpha.0"'))
  })
  test("throws for a missing package", () => expect(() => setLockVersion(lock, "nope", "1.0.0")).toThrow("no nope"))
})
