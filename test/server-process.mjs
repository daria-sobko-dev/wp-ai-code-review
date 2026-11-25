// Runs the fake APIs in a separate process for action tests.
import { startFakeApis } from "./fixtures.mjs";
const api = await startFakeApis(JSON.parse(process.argv[2] || "{}"));
process.send({ url: api.url });
process.on("message", (m) => { if (m === "calls") process.send({ calls: api.calls }); });
