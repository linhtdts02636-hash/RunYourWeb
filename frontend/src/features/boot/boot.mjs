import { Daytona } from "@daytona/sdk";

const daytona = new Daytona(); // reads DAYTONA_API_KEY

const PORT = 3000;
const SESSION = "app";
const SMALL = "daytona-small"; // 1 vCPU / 1 GiB; every run starts here
const SESSION_MAX_MIN = 30; // hard wall-clock cap (doc: 20 min usable + boot time)

const JAVA_SETUP =
  "command -v mvn >/dev/null && command -v java >/dev/null || " +
  "(sudo apt-get update -qq && sudo apt-get install -y -qq default-jdk maven)";

// Minimal Repo Analyzer: static analysis of the clone -> Boot Plan.
// ponytail: vanilla Java must read PORT env and serve HTTP; add mainClass detection later.
function analyze(probe) {
  const files = probe.split("\n");
  if (files.includes("pom.xml")) {
    return {
      kind: files.includes("__SPRING__") ? "java-spring-boot-maven" : "java-vanilla-maven",
      snapshot: "daytona-medium", // 2 vCPU / 4 GiB: Maven builds need the RAM
      setup: JAVA_SETUP,
      start: `mvn -q -DskipTests package && PORT=${PORT} SERVER_PORT=${PORT} java -jar $(ls target/*.jar | grep -v original | head -1)`,
      timeoutMs: 300_000,
    };
  }
  if (files.includes("index.html")) {
    return { kind: "static", snapshot: SMALL, start: `python3 -m http.server ${PORT}`, timeoutMs: 60_000 };
  }
  throw new Error("Analysis Failed: no pom.xml or index.html at repo root");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts: { branch?, sha?, token? } — token = short-lived read-only GitHub token for private repos.
export async function boot(repoUrl, { branch, sha, token } = {}, log = console.log) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(repoUrl)) {
    throw new Error("repoUrl must be https://github.com/<owner>/<repo>");
  }
  if (branch && !/^[\w./-]+$/.test(branch)) throw new Error("invalid branch");
  if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("invalid sha");
  if (token && !/^[\w-]+$/.test(token)) throw new Error("invalid token");

  // Size is fixed at create time, so: create SMALL, clone, analyze; only Java gets re-created bigger.
  const make = async (snapshot) => {
    log(`Provisioning sandbox (${snapshot})`);
    const sb = await daytona.create({
      snapshot,
      // no token -> public preview; token (private repo) -> private sandbox + signed preview URL
      public: !token,
      autoStopInterval: 10,
      autoDeleteInterval: 0, // delete as soon as it stops, so leftovers never fill the disk quota
      ttlMinutes: SESSION_MAX_MIN,
    });
    try {
      const d = `${await sb.getWorkDir()}/app`;
      log("Cloning repo inside the sandbox (git payload, no local copy)");
      await sb.git.clone(
        repoUrl, d, branch, sha,
        token ? "x-access-token" : undefined, token,
        false, sha ? undefined : 1 // a pinned sha needs full history
      );
      return { sandbox: sb, dir: d };
    } catch (e) {
      await sb.delete().catch(() => {});
      throw e;
    }
  };

  let { sandbox, dir } = await make(SMALL);
  try {
    const probe = await sandbox.process.executeCommand(
      `ls && (grep -qs spring-boot pom.xml && echo __SPRING__ || true)`, dir, undefined, 60
    );
    const plan = analyze(probe.result);
    log(`Boot Plan: ${plan.kind}`);
    if (plan.snapshot !== SMALL) {
      log(`Needs ${plan.snapshot}: re-provisioning`);
      await sandbox.delete();
      ({ sandbox, dir } = await make(plan.snapshot));
    }
    if (plan.setup) {
      log("Ensuring JDK + Maven");
      const r = await sandbox.process.executeCommand(plan.setup, dir, undefined, 600);
      if (r.exitCode !== 0) throw new Error(`Provisioning Failed: ${r.result}`);
    }

    log("Starting");
    await sandbox.process.createSession(SESSION);
    const cmd = await sandbox.process.executeSessionCommand(SESSION, {
      command: `cd ${dir} && ${plan.start}`,
      runAsync: true,
    });

    const deadline = Date.now() + plan.timeoutMs;
    for (;;) {
      const up = await sandbox.process.executeCommand(
        `timeout 2 bash -c '</dev/tcp/127.0.0.1/${PORT}' && echo up`, undefined, undefined, 10
      );
      if (up.result.includes("up")) break;
      const st = await sandbox.process.getSessionCommand(SESSION, cmd.cmdId);
      const exited = st.exitCode !== undefined && st.exitCode !== null;
      if (exited || Date.now() > deadline) {
        const logs = await sandbox.process.getSessionCommandLogs(SESSION, cmd.cmdId);
        throw new Error(
          `${exited ? `Startup Failed (exit ${st.exitCode})` : "Startup timed out"}\n--- app log ---\n${(logs.output || "").slice(-3000)}`
        );
      }
      await sleep(2000);
    }

    const previewUrl = token
      ? (await sandbox.getSignedPreviewUrl(PORT, 3600)).url
      : (await sandbox.getPreviewLink(PORT)).url;
    return { sandboxId: sandbox.id, previewUrl };
  } catch (e) {
    await sandbox.delete().catch(() => {});
    if (token) e.message = String(e.message).replaceAll(token, "***");
    throw e;
  }
}

export async function stop(id) {
  await daytona.delete(await daytona.get(id));
}
