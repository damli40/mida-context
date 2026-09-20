// Stub extractor that emits non-JSON garbage. Exits cleanly on empty stdin.

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  process.stdout.write("I could not extract anything. {{{ not json\n");
});
