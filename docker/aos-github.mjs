// GitHub access inside the container, for git and gh. It never sees a private key: it writes a
// request file into the spool directory aos mounted for this launch, and aos on the Mac answers
// with a token for the one repository this session may use (src/github.ts).
//
//   aos-github.mjs credential <get|store|erase>   git credential helper
//   aos-github.mjs token                          prints a token, used by the gh wrapper
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WAIT_MS = 90_000;
const POLL_MS = 50;

const spool = process.env.AOS_GITHUB_SPOOL;
const status =
  process.env.AOS_GITHUB_STATUS ??
  "GitHub access is not available in this container. Start the session with aos on the Mac, after setting up GitHub access (README, \"GitHub access\").";

function fail(message) {
  console.error(`aos: ${message}`);
}

async function request(path) {
  const id = randomBytes(16).toString("hex");
  const staging = join(spool, `${id}.req.tmp`);
  writeFileSync(staging, JSON.stringify({ host: "github.com", ...(path ? { path } : {}) }));
  renameSync(staging, join(spool, `${id}.req`));
  const answer = join(spool, `${id}.res`);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(answer)) {
      const response = JSON.parse(readFileSync(answer, "utf8"));
      rmSync(answer, { force: true });
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  rmSync(join(spool, `${id}.req`), { force: true });
  return { ok: false, message: "aos on the Mac did not answer in time. Is the aos session still running?" };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return Object.fromEntries(
    input
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const [command, action] = process.argv.slice(2);

if (command === "credential") {
  if (action !== "get") process.exit(0);
  const fields = await readStdin();
  if (fields.host !== "github.com" || fields.protocol !== "https") process.exit(0);
  if (!spool) {
    fail(status);
    process.exit(0);
  }
  const response = await request(fields.path);
  if (!response.ok) {
    fail(response.message);
    process.exit(0);
  }
  process.stdout.write(`username=x-access-token\npassword=${response.token}\n`);
} else if (command === "token") {
  if (!spool) {
    fail(status);
    process.exit(1);
  }
  const response = await request();
  if (!response.ok) {
    fail(response.message);
    process.exit(1);
  }
  process.stdout.write(`${response.token}\n`);
} else {
  fail("usage: aos-github.mjs credential <get|store|erase> | token");
  process.exit(2);
}
