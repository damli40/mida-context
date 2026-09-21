// The real helpers live in sponsor-probe-lib.mts: sponsor-probe.mts is an .mts module and under
// moduleResolution NodeNext an .mts importer cannot resolve a .ts sibling — ".js" specifiers map
// to .mjs/.mts there. This file keeps the path the first M3-B run created importable; new code
// should import "./sponsor-probe-lib.mjs" (which resolves the .mts source).
export * from "./sponsor-probe-lib.mjs"
