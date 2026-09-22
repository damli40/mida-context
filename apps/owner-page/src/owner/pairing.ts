import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js"

/**
 * The pairing code — the thing that stops a lookalike link from borrowing the real page.
 *
 * The terminal prints a code; this page shows the same code in large type. Both sides derive it
 * independently from the exact request bytes: `sha256("mida.pair.v1" ‖ requestBytes)`. The first
 * three digest bytes pick three words; the fourth byte picks two digits. An attacker who changes
 * a single byte of the request changes all four outputs, so a forged link always shows a code the
 * terminal did not print.
 *
 * FROZEN: the word list, the domain separator, and the byte-to-code mapping below are the wire
 * contract between this page and the terminal. Changing any of them orphans every in-flight
 * request — bump the "v1" tag instead, never edit in place.
 */

const DOMAIN = utf8ToBytes("mida.pair.v1")

/**
 * 256 common, distinct words — one per byte value. Chosen to be easy to say over a screen share
 * and hard to confuse with each other; the list is the contract, so the entries and their order
 * never change.
 */
export const PAIRING_WORDS: readonly string[] = [
  "apple", "arrow", "atlas", "autumn", "badge", "bamboo", "banner", "beacon",
  "beetle", "birch", "blossom", "bonnet", "border", "bottle", "bridge", "bronze",
  "brook", "bucket", "butter", "cabin", "cactus", "canoe", "canvas", "castle",
  "cedar", "cello", "chalk", "chapel", "cheese", "cherry", "chimney", "cider",
  "cinema", "circle", "cliff", "clover", "coast", "cobalt", "cocoa", "comet",
  "compass", "copper", "corner", "cotton", "cradle", "crane", "crater", "cricket",
  "crystal", "dagger", "daisy", "dancer", "delta", "desert", "diamond", "dinner",
  "dome", "donkey", "dragon", "drizzle", "drum", "dusk", "eagle", "engine",
  "estuary", "fabric", "falcon", "feather", "fennel", "fern", "finch", "fjord",
  "flame", "flint", "flute", "foam", "forest", "fountain", "frost", "galaxy",
  "garden", "garlic", "garnet", "gate", "glacier", "glen", "globe", "glove",
  "goat", "gold", "goose", "granite", "grape", "gravel", "grove", "guitar",
  "harbor", "harp", "hazel", "hearth", "hedge", "heron", "hill", "honey",
  "horizon", "iceberg", "igloo", "index", "ink", "island", "ivory", "jacket",
  "jade", "jasmine", "jasper", "jewel", "jigsaw", "journal", "jungle", "kayak",
  "kettle", "keystone", "kingdom", "kite", "ladder", "lagoon", "lantern", "lark",
  "lava", "lemon", "lens", "lilac", "linen", "lion", "locket", "lodge",
  "lotus", "lumber", "magnet", "maple", "marble", "meadow", "melody", "melon",
  "mercury", "mermaid", "mint", "mirror", "mist", "monkey", "moon", "mosaic",
  "moth", "mountain", "mouse", "muffin", "museum", "mushroom", "music", "nectar",
  "needle", "nest", "nickel", "north", "oak", "oasis", "ocean", "olive",
  "onion", "opal", "orange", "orbit", "orchard", "oval", "owl", "paddle",
  "palace", "palm", "panda", "parcel", "parrot", "peach", "pebble", "pelican",
  "pencil", "pepper", "piano", "picnic", "pillar", "pine", "planet", "plum",
  "pocket", "porch", "potato", "prairie", "prism", "pumpkin", "puzzle", "quartz",
  "quiver", "rabbit", "radar", "rainbow", "raven", "reed", "ribbon", "ridge",
  "river", "rocket", "root", "rose", "ruby", "saddle", "saffron", "sail",
  "salmon", "sand", "sapphire", "satin", "scarab", "scent", "seed", "shadow",
  "shell", "shield", "shore", "silk", "silver", "skylark", "slate", "smoke",
  "snow", "soap", "solar", "sparrow", "spear", "spice", "spider", "spiral",
  "sponge", "spring", "spruce", "square", "stable", "star", "steam", "stone",
  "storm", "stream", "string", "sugar", "summer", "summit", "sunset", "swan",
]

/**
 * Three words and two digits from the exact request bytes. Example: "atlas sugar orbit 07".
 * Both sides call this on the same bytes and must print the same string.
 */
export function pairingCode(requestBytes: Uint8Array): string {
  const digest = sha256(concatBytes(DOMAIN, requestBytes))
  const words = [digest[0]!, digest[1]!, digest[2]!].map((b) => PAIRING_WORDS[b]!)
  const digits = String(digest[3]! % 100).padStart(2, "0")
  return `${words.join(" ")} ${digits}`
}
