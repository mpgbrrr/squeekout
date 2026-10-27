// Fake Squeekchain /v1/status: the hamster runs from RUN_FROM to RUN_TO (unix seconds), then stops.
// Like the real device, readings arrive every 10 s.
import { createServer } from "node:http";
const [runFrom, runTo] = process.argv.slice(2).map(Number);
let counter = 1000;
const reading = () => {
  const now = Math.floor(Date.now() / 1000);
  const tick = now - (now % 10);
  const ran = Math.max(0, Math.min(tick, runTo) - runFrom);
  const running = tick >= runFrom && tick < runTo;
  return { measurement: { observedAt: new Date(tick * 1000).toISOString(), cumulativeWorkUnits: String(counter + Math.floor(ran * 1.2)),
    freshness: "online", coreStatus: running ? "ACTIVE" : "IDLE", counterEpoch: "e2e-epoch", rpmMilli: running ? 72000 : 0 } };
};
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(reading()));
}).listen(8787, () => console.log("fake feed on 8787", { runFrom, runTo }));
