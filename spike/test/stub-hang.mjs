// Stub extractor that hangs forever once it receives input — used to prove
// the capture hook's extractor timeout works. Exits cleanly on empty stdin.

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  setInterval(() => {}, 60_000);
});
