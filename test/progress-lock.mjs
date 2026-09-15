import { createInterface } from "node:readline";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { progressWriter } from "../src/progress.ts";

const dir = process.argv[2];
const writer = progressWriter({ id: "progress-lock-fixture", dir });
const lines = [];
const input = createInterface({ input: process.stdin });
let stream;
const deadline = setTimeout(() => { console.error("fixture timeout"); process.exit(2); }, 15000);
input.on("line", command => {
  if (command === "start") {
    let i = 0;
    stream = setInterval(() => {
      const line = String(i++).padStart(3, "0");
      lines.push(line);
      writer.update({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: (lines.length > 1 ? "\n" : "") + line } });
      if (i === 101) {
        clearInterval(stream);
        writeFileSync(join(dir, "output.md"), lines.join("\n"), "utf8");
        console.log(JSON.stringify({ stage: "streamed", lines: lines.length }));
      }
    }, 8);
  } else if (command === "finish") {
    writer.finish("completed");
    clearTimeout(deadline);
    input.close();
    console.log(JSON.stringify({ stage: "finished" }));
  }
});
console.log(JSON.stringify({ stage: "ready" }));
