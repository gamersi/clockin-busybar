import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";

// On the bar, JerryScript loses `this` inside async arrow functions
// ("Cannot read property 'refresh' of undefined"). Keep such code in methods.
it("src has no async arrow function that uses this", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const arrow = /async\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]+)?=>/g;
    let match: RegExpExecArray | null;
    while ((match = arrow.exec(source)) !== null) {
      // Scan the arrow's body up to its matching closing bracket.
      let depth = 0;
      let end = match.index + match[0].length;
      for (; end < source.length; end++) {
        const ch = source[end];
        if ("({[".includes(ch)) depth++;
        else if (")}]".includes(ch)) {
          if (depth === 0) break;
          depth--;
          if (depth === 0 && ch === "}") { end++; break; }
        } else if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) break;
      }
      const body = source.slice(match.index, end);
      const line = source.slice(0, match.index).split("\n").length;
      assert.ok(!/\bthis\b/.test(body), `${file}:${line} uses this inside an async arrow function`);
    }
  }
});
