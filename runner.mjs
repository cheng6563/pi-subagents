import { createJiti } from "jiti";

// Exactly one closure-bound launch arrives from the owning parent IPC channel.
if (!process.send || !process.env.PI_GENERIC_SUBAGENT) throw new Error("The generic runner requires a parent IPC launch");
process.once("message", async (input) => {
  const pending = [];
  const collect = (message) => pending.push(message);
  process.on("message", collect);
  try {
    const jiti = createJiti(import.meta.url, { alias: JSON.parse(process.env.JITI_ALIAS || "{}") });
    const { runWorker } = await jiti.import("./src/runner.ts");
    process.off("message", collect);
    await runWorker(input, pending);
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ event: "runner_failed", error: String(error) }));
    process.exit(1);
  }
});
