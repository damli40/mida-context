import { describe, expect, it } from "vitest"
import { recordPath } from "../src/record-path.js"

describe("recordPath", () => {
  it("Mac and Linux behaviour is unchanged", () => {
    expect(recordPath("/u/j/proj/src/a.ts", "/u/j/proj", "/u/j", "darwin")).toBe("src/a.ts")
    expect(recordPath("/u/j/notes/x.md", "/u/j/proj", "/u/j", "linux")).toBe("~/notes/x.md")
    expect(recordPath("/etc/hosts", "/u/j/proj", "/u/j", "darwin")).toBe("/etc/hosts")
    expect(recordPath("/u/j", "/u/j/proj", "/", "darwin")).toBe("/u/j")
  })

  it("Windows: project paths become relative, case and slash style ignored", () => {
    expect(recordPath("C:\\Users\\Jane\\proj\\src\\a.ts", "C:\\Users\\Jane\\proj", "C:\\Users\\Jane", "win32")).toBe("src\\a.ts")
    expect(recordPath("c:\\users\\jane\\proj\\src\\a.ts", "C:\\Users\\Jane\\proj", "C:\\Users\\Jane", "win32")).toBe("src\\a.ts")
    expect(recordPath("C:/Users/Jane/proj/src/a.ts", "C:\\Users\\Jane\\proj", "C:\\Users\\Jane", "win32")).toBe("src/a.ts")
  })

  it("Windows: paths under the user folder become ~", () => {
    expect(recordPath("C:\\Users\\Jane\\Documents\\x.md", "C:\\Users\\Jane\\proj", "C:\\Users\\Jane", "win32")).toBe("~\\Documents\\x.md")
    expect(recordPath("D:\\data\\x.md", "C:\\Users\\Jane\\proj", "C:\\Users\\Jane", "win32")).toBe("D:\\data\\x.md")
  })
})
